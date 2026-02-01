import blessed from 'blessed';
import { RalphState, RalphExecution } from './types';
import { StateLoader } from './state-loader';

type DisplayStatus = 'RUN' | 'MRG' | 'WAIT' | 'ERR' | 'OK';

export class MonitorUI {
  private screen: blessed.Widgets.Screen;
  private overviewBox!: blessed.Widgets.BoxElement;
  private executionList!: blessed.Widgets.ListElement;
  private logBox!: blessed.Widgets.BoxElement;
  private statusBar!: blessed.Widgets.TextElement;
  private stateLoader: StateLoader;
  private selectedIndex: number = 0;
  private expandedBranches: Set<string> = new Set();
  private executionRowBranches: string[] = [];

  constructor(stateLoader: StateLoader) {
    this.stateLoader = stateLoader;
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Ralph MCP Monitor',
      fullUnicode: true,
      dockBorders: true
    });

    this.createLayout();
    this.setupKeyBindings();
  }

  private createLayout() {
    // Overview box (top)
    this.overviewBox = blessed.box({
      top: 0,
      left: 0,
      width: '100%',
      height: 4,
      content: 'Loading...',
      tags: true,
      border: {
        type: 'line'
      },
      style: {
        border: {
          fg: 'cyan'
        }
      }
    });

    // Execution list (middle)
    this.executionList = blessed.list({
      top: 4,
      left: 0,
      width: '100%',
      height: '70%-4',
      tags: true,
      keys: true,
      vi: true,
      mouse: true,
      scrollbar: {
        ch: '|',
        style: {
          fg: 'cyan'
        }
      },
      border: {
        type: 'line'
      },
      style: {
        border: {
          fg: 'cyan'
        },
        selected: {
          bg: 'blue',
          fg: 'white'
        }
      }
    });

    // Log box (bottom)
    this.logBox = blessed.box({
      top: '70%',
      left: 0,
      width: '100%',
      height: '30%-1',
      tags: true,
      border: {
        type: 'line'
      },
      style: {
        border: {
          fg: 'cyan'
        }
      },
      scrollable: true,
      scrollbar: {
        ch: '|',
        style: {
          fg: 'cyan'
        }
      }
    });

    // Status bar (very bottom)
    this.statusBar = blessed.text({
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      content: ' [q]uit [r]efresh [space]expand/collapse [Up/Down or j/k]navigate',
      style: {
        bg: 'blue',
        fg: 'white'
      }
    });

    this.screen.append(this.overviewBox);
    this.screen.append(this.executionList);
    this.screen.append(this.logBox);
    this.screen.append(this.statusBar);

    this.executionList.focus();
  }

  private setupKeyBindings() {
    this.screen.key(['q', 'C-c'], () => {
      return process.exit(0);
    });

    this.screen.key(['r'], () => {
      this.refresh();
    });

    this.screen.key(['space'], () => {
      this.toggleExpand();
    });

    this.executionList.key(['enter'], () => {
      this.toggleExpand();
    });
  }

  private toggleExpand() {
    const selected = (this.executionList as any).selected || 0;
    const branch = this.executionRowBranches[selected];
    if (!branch) return;

    if (this.expandedBranches.has(branch)) {
      this.expandedBranches.delete(branch);
    } else {
      this.expandedBranches.add(branch);
    }

    this.refresh();
  }

  refresh() {
    const state = this.stateLoader.loadState();
    this.updateOverview(state);
    this.updateExecutionList(state);
    this.updateLogs(state);
    this.screen.render();
  }

  private updateOverview(state: RalphState) {
    const executions = this.getExecutions(state);
    const progress = this.getOverallStoryProgress(state, executions);
    const counts: Record<DisplayStatus, number> = { RUN: 0, MRG: 0, WAIT: 0, ERR: 0, OK: 0 };

    executions.forEach(exec => {
      const displayStatus = this.getDisplayStatus(exec, state);
      counts[displayStatus]++;
    });

    const content = [
      `{cyan-fg}{bold}Ralph MCP Monitor{/bold}{/cyan-fg}  State: ${this.stateLoader.getStateFilePath()}`,
      `PRDs: {yellow-fg}${counts.RUN} run{/yellow-fg} | {blue-fg}${counts.MRG} merge{/blue-fg} | {gray-fg}${counts.WAIT} wait{/gray-fg} | {red-fg}${counts.ERR} fail{/red-fg} | {green-fg}${counts.OK} ok{/green-fg}`,
      progress.total === 0
        ? `Stories: {gray-fg}parsing...{/gray-fg}`
        : `Stories: {green-fg}${progress.done}/${progress.total}{/green-fg} done (${Math.round(progress.done / progress.total * 100)}%)`
    ].join('\n');

    this.overviewBox.setContent(content);
  }

  private updateExecutionList(state: RalphState) {
    const executions = this.getExecutions(state);
    const previousSelected = (this.executionList as any).selected || 0;
    const previousBranch = this.executionRowBranches[previousSelected];
    const previousOccurrence =
      previousBranch
        ? this.executionRowBranches.slice(0, previousSelected).filter(b => b === previousBranch).length
        : 0;
    const items: string[] = [];
    const rowBranches: string[] = [];

    const sortedExecutions = [...executions].sort((a, b) => this.compareExecutions(a, b, state));

    sortedExecutions.forEach(exec => {
      const statusIcon = this.getStatusIcon(exec, state);
      const branchName = this.stripRalphPrefix(exec.branch);

      const progressLabel = this.formatExecutionProgress(exec, state);
      const userStories = this.getExecutionStories(exec, state);

      const isExpanded = this.expandedBranches.has(exec.branch);
      const expandIcon = isExpanded ? 'v' : '>';

      items.push(`${expandIcon} ${statusIcon} {bold}${branchName}{/bold} ${progressLabel}`);
      rowBranches.push(exec.branch);

      if (isExpanded && userStories.length > 0) {
        userStories.forEach(story => {
          const storyStatus = this.getStoryStatus(story);
          const storyIcon = this.getStoryIcon(storyStatus);
          const storyId = this.getStoryId(story);
          const storyTitle = this.getStoryTitle(story, storyId);
          items.push(`    ${storyIcon} ${storyId}: ${storyTitle}`);
          rowBranches.push(exec.branch);
        });
      }
    });

    if (items.length === 0) {
      items.push('No executions found. Start a PRD with ralph_start.');
    }

    this.executionRowBranches = rowBranches;
    this.executionList.setItems(items);

    if (items.length > 0) {
      let nextSelected = Math.max(0, Math.min(previousSelected, items.length - 1));

      if (previousBranch) {
        let occurrence = 0;
        for (let i = 0; i < rowBranches.length; i++) {
          if (rowBranches[i] !== previousBranch) continue;
          if (occurrence === previousOccurrence) {
            nextSelected = i;
            break;
          }
          occurrence++;
        }
      }

      this.executionList.select(nextSelected);
    }
  }

  private updateLogs(state: RalphState) {
    const executions = this.getExecutions(state);
    const activeExecutions = executions
      .filter(e => {
        const displayStatus = this.getDisplayStatus(e, state);
        return displayStatus === 'RUN' || displayStatus === 'MRG';
      })
      .sort((a, b) => this.compareExecutions(a, b, state))
      .slice(0, 5);

    const logs: string[] = [];

    if (activeExecutions.length > 0) {
      logs.push('{bold}Active executions{/bold}');

      activeExecutions.forEach(exec => {
        const branchName = this.stripRalphPrefix(exec.branch);
        const statusIcon = this.getStatusIcon(exec, state);
        const progressLabel = this.formatExecutionProgress(exec, state);
        logs.push(`${statusIcon} {bold}${branchName}{/bold} ${progressLabel}`);

        const metrics = this.getExecutionMetrics(exec);
        if (metrics) logs.push(`  ${metrics}`);

        const lastError = (exec as any).lastError;
        if (typeof lastError === 'string' && lastError.trim().length > 0) {
          logs.push(`  {red-fg}error:{/red-fg} ${this.truncateText(lastError.trim(), 160)}`);
        }

        const stories = this.getExecutionStories(exec, state);
        const latestDone = stories.filter(s => this.isStoryDone(s)).slice(-1)[0];
        if (latestDone) {
          const storyId = this.getStoryId(latestDone);
          const title = this.getStoryTitle(latestDone, storyId);
          logs.push(`  latest: {green-fg}${storyId}{/green-fg} ${title}`);
        }
      });
    } else {
      const recentFailed = executions
        .filter(e => this.getDisplayStatus(e, state) === 'ERR')
        .sort((a, b) => this.getExecutionSortTime(b) - this.getExecutionSortTime(a))
        .slice(0, 3);

      const recentOk = executions
        .filter(e => this.getDisplayStatus(e, state) === 'OK')
        .sort((a, b) => this.getExecutionSortTime(b) - this.getExecutionSortTime(a))
        .slice(0, 3);

      const waiting = executions
        .filter(e => this.getDisplayStatus(e, state) === 'WAIT')
        .sort((a, b) => this.getExecutionSortTime(b) - this.getExecutionSortTime(a))
        .slice(0, 3);

      if (recentFailed.length === 0 && recentOk.length === 0 && waiting.length === 0) {
        logs.push('All quiet. No active executions.');
      } else {
        if (recentFailed.length > 0) {
          logs.push('{red-fg}{bold}Recent failures{/bold}{/red-fg}');
          recentFailed.forEach(exec => {
            const branchName = this.stripRalphPrefix(exec.branch);
            logs.push(`{red-fg}ERR{/red-fg} {bold}${branchName}{/bold}`);
            const lastError = (exec as any).lastError;
            if (typeof lastError === 'string' && lastError.trim().length > 0) {
              logs.push(`  ${this.truncateText(lastError.trim(), 180)}`);
            }
          });
        }

        if (waiting.length > 0) {
          if (logs.length > 0) logs.push('');
          logs.push('{gray-fg}{bold}Waiting{/bold}{/gray-fg}');
          waiting.forEach(exec => {
            const branchName = this.stripRalphPrefix(exec.branch);
            const reason = this.getWaitReason(exec, state);
            logs.push(`{gray-fg}WAIT{/gray-fg} {bold}${branchName}{/bold}${reason ? ` {gray-fg}(${reason}){/gray-fg}` : ''}`);
          });
        }

        if (recentOk.length > 0) {
          if (logs.length > 0) logs.push('');
          logs.push('{green-fg}{bold}Recent completed{/bold}{/green-fg}');
          recentOk.forEach(exec => {
            const branchName = this.stripRalphPrefix(exec.branch);
            logs.push(`{green-fg}OK{/green-fg} {bold}${branchName}{/bold}`);
          });
        }
      }
    }

    this.logBox.setContent(logs.join('\n'));
  }

  private getStatusIcon(exec: RalphExecution, state: RalphState): string {
    const status = (exec as any).status as string | undefined;
    const displayStatus = this.getDisplayStatus(exec, state);

    switch (displayStatus) {
      case 'RUN':
        return '{yellow-fg}RUN{/yellow-fg}';
      case 'MRG':
        return '{blue-fg}MRG{/blue-fg}';
      case 'ERR':
        return '{red-fg}ERR{/red-fg}';
      case 'OK':
        return '{green-fg}OK{/green-fg}';
      case 'WAIT': {
        const reason = this.getWaitReason(exec, state);
        const badge = '{gray-fg}WAIT{/gray-fg}';
        return reason ? `${badge} {gray-fg}(${reason}){/gray-fg}` : badge;
      }
      default:
        return typeof status === 'string' ? status : 'WAIT';
    }
  }

  private getStoryIcon(status: string): string {
    switch (status) {
      case 'running': return '{yellow-fg}>{/yellow-fg}';
      case 'passed': return '{green-fg}+{/green-fg}';
      case 'failed': return '{red-fg}x{/red-fg}';
      default: return '{gray-fg}o{/gray-fg}';
    }
  }

  private getExecutions(state: RalphState): RalphExecution[] {
    const executions = (state as any).executions;
    if (!executions) return [];
    if (Array.isArray(executions)) return executions as RalphExecution[];
    return Object.values(executions) as RalphExecution[];
  }

  private getExecutionStories(exec: RalphExecution, state: RalphState): any[] {
    const legacyStories = (exec as any).userStories;
    if (Array.isArray(legacyStories)) return legacyStories;

    const executionId = (exec as any).id as string | undefined;
    const stories = (state as any).userStories;
    if (!executionId || !Array.isArray(stories)) return [];

    return stories.filter((s: any) => s && s.executionId === executionId);
  }

  private getOverallStoryProgress(state: RalphState, executions: RalphExecution[]) {
    const topLevelStories = (state as any).userStories;
    if (Array.isArray(topLevelStories)) {
      const total = topLevelStories.length;
      const done = topLevelStories.filter((s: any) => this.isStoryDone(s)).length;
      return { total, done };
    }

    let total = 0;
    let done = 0;
    executions.forEach(exec => {
      const stories = this.getExecutionStories(exec, state);
      total += stories.length;
      done += stories.filter(s => this.isStoryDone(s)).length;
    });

    return { total, done };
  }

  private isStoryDone(story: any): boolean {
    if (!story) return false;
    if (typeof story.passes === 'boolean') return story.passes;
    if (typeof story.status === 'string') return story.status === 'passed';
    return false;
  }

  private getStoryStatus(story: any): string {
    if (!story) return 'pending';
    if (typeof story.status === 'string') return story.status;
    if (typeof story.passes === 'boolean') return story.passes ? 'passed' : 'pending';
    return 'pending';
  }

  private getStoryId(story: any): string {
    return (story?.storyId || story?.id || 'unknown') as string;
  }

  private getStoryTitle(story: any, fallback: string): string {
    return (story?.title || fallback) as string;
  }

  private getDisplayStatus(exec: RalphExecution, state: RalphState): DisplayStatus {
    const rawStatus = ((exec as any).status as string | undefined)?.toLowerCase();
    const mergeQueueStatus = this.getMergeQueueStatus(exec, state)?.toLowerCase();

    if (rawStatus === 'running') return 'RUN';
    if (rawStatus === 'failed') return 'ERR';
    if (rawStatus === 'merging' || mergeQueueStatus === 'merging') return 'MRG';
    if (rawStatus === 'completed' || rawStatus === 'merged' || rawStatus === 'succeeded' || rawStatus === 'success') return 'OK';

    return 'WAIT';
  }

  private getMergeQueueStatus(exec: RalphExecution, state: RalphState): string | undefined {
    const mergeQueue = (state as any).mergeQueue;
    if (!mergeQueue) return undefined;

    if (Array.isArray(mergeQueue)) {
      if (mergeQueue.length === 0) return undefined;
      const first = mergeQueue[0];

      if (typeof first === 'string') {
        return undefined;
      }

      const executionId = (exec as any).id;
      if (!executionId) return undefined;

      const item = mergeQueue.find((q: any) => q && q.executionId === executionId);
      return item?.status;
    }

    return undefined;
  }

  private getMergeQueuePosition(exec: RalphExecution, state: RalphState): number | undefined {
    const explicit = (exec as any).mergeQueuePosition;
    if (typeof explicit === 'number') return explicit;

    const mergeQueue = (state as any).mergeQueue;
    if (!Array.isArray(mergeQueue) || mergeQueue.length === 0) return undefined;
    const first = mergeQueue[0];

    if (typeof first === 'string') {
      const idx = mergeQueue.indexOf(exec.branch as any);
      return idx >= 0 ? idx + 1 : undefined;
    }

    const executionId = (exec as any).id;
    if (!executionId) return undefined;

    const item = mergeQueue.find((q: any) => q && q.executionId === executionId);
    const pos = item?.position;
    return typeof pos === 'number' ? pos : undefined;
  }

  private getWaitReason(exec: RalphExecution, state: RalphState): string | undefined {
    const rawStatus = ((exec as any).status as string | undefined)?.toLowerCase();

    const deps = (exec as any).dependencies;
    if (Array.isArray(deps) && deps.length > 0) {
      const unresolved = this.getUnresolvedDependencies(deps, state);
      if (unresolved.length > 0) {
        const head = this.stripRalphPrefix(unresolved[0]);
        return unresolved.length > 1 ? `dep: ${head} (+${unresolved.length - 1})` : `dep: ${head}`;
      }
    }

    const queuePos = this.getMergeQueuePosition(exec, state);
    if (typeof queuePos === 'number' && queuePos > 0) return `queue: #${queuePos}`;

    const stories = this.getExecutionStories(exec, state);
    if (stories.length === 0) {
      if (rawStatus === 'running' || rawStatus === 'pending') return 'starting...';
      return 'no stories';
    }

    if (rawStatus === 'pending') return 'starting...';

    return undefined;
  }

  private getUnresolvedDependencies(dependencies: string[], state: RalphState): string[] {
    const executions = this.getExecutions(state);
    const byBranch = new Map(executions.map(e => [e.branch, e] as const));
    const okStatuses = new Set(['completed', 'merged', 'succeeded', 'success']);

    return dependencies.filter(dep => {
      const exec = byBranch.get(dep);
      if (!exec) return true;
      const status = ((exec as any).status as string | undefined)?.toLowerCase();
      return !status || !okStatuses.has(status);
    });
  }

  private formatExecutionProgress(exec: RalphExecution, state: RalphState): string {
    const stories = this.getExecutionStories(exec, state);
    const total = stories.length;
    const done = stories.filter(s => this.isStoryDone(s)).length;

    if (total === 0) {
      const reason = this.getWaitReason(exec, state);
      const label = reason === 'starting...' ? 'parsing...' : reason === 'no stories' ? 'no stories' : 'parsing...';
      return `{gray-fg}[${label}]{/gray-fg}`;
    }

    if (done === 0) return `{gray-fg}[0/${total} stories]{/gray-fg}`;
    return `{green-fg}[${done}/${total} done]{/green-fg}`;
  }

  private compareExecutions(a: RalphExecution, b: RalphExecution, state: RalphState): number {
    const statusA = this.getDisplayStatus(a, state);
    const statusB = this.getDisplayStatus(b, state);
    const priorityA = this.getDisplayStatusPriority(statusA);
    const priorityB = this.getDisplayStatusPriority(statusB);
    if (priorityA !== priorityB) return priorityA - priorityB;

    const timeA = this.getExecutionSortTime(a);
    const timeB = this.getExecutionSortTime(b);
    if (timeA !== timeB) return timeB - timeA;

    return this.stripRalphPrefix(a.branch).localeCompare(this.stripRalphPrefix(b.branch));
  }

  private getDisplayStatusPriority(status: DisplayStatus): number {
    switch (status) {
      case 'RUN': return 0;
      case 'MRG': return 1;
      case 'WAIT': return 2;
      case 'ERR': return 3;
      case 'OK': return 4;
    }
  }

  private getExecutionSortTime(exec: RalphExecution): number {
    const candidates = [
      (exec as any).updatedAt,
      (exec as any).completedAt,
      (exec as any).startedAt,
      (exec as any).createdAt,
    ];

    for (const v of candidates) {
      const ms = this.parseTimestamp(v);
      if (ms) return ms;
    }

    return 0;
  }

  private parseTimestamp(value?: string): number {
    if (!value) return 0;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? 0 : ms;
  }

  private stripRalphPrefix(branch: string): string {
    return branch.replace(/^ralph\//, '');
  }

  private getExecutionMetrics(exec: RalphExecution): string | undefined {
    const parts: string[] = [];

    const loopCount = (exec as any).loopCount;
    const noProgress = (exec as any).consecutiveNoProgress;
    const errors = (exec as any).consecutiveErrors;
    const files = (exec as any).lastFilesChanged;
    const updatedAt = (exec as any).updatedAt;

    if (typeof updatedAt === 'string' && updatedAt.trim().length > 0) {
      const ms = this.parseTimestamp(updatedAt);
      if (ms > 0) parts.push(`updated ${this.formatAge(ms)}`);
    }

    if (typeof loopCount === 'number') parts.push(`loops:${loopCount}`);
    if (typeof noProgress === 'number') parts.push(`no-progress:${noProgress}`);
    if (typeof errors === 'number') parts.push(`errors:${errors}`);
    if (typeof files === 'number') parts.push(`files:${files}`);

    return parts.length > 0 ? parts.join(' | ') : undefined;
  }

  private formatAge(timestampMs: number): string {
    const deltaSec = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
    if (deltaSec < 60) return `${deltaSec}s ago`;
    const deltaMin = Math.floor(deltaSec / 60);
    if (deltaMin < 60) return `${deltaMin}m ago`;
    const deltaHr = Math.floor(deltaMin / 60);
    if (deltaHr < 48) return `${deltaHr}h ago`;
    const deltaDay = Math.floor(deltaHr / 24);
    return `${deltaDay}d ago`;
  }

  private truncateText(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return `${text.slice(0, Math.max(0, maxLen - 3))}...`;
  }

  render() {
    this.screen.render();
  }
}
