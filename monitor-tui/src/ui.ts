import blessed from 'blessed';
import { statSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { RalphState, RalphExecution } from './types';
import { StateLoader } from './state-loader';

type DisplayStatus = 'RUN' | 'MRG' | 'WAIT' | 'ERR' | 'OK';
type ViewMode = 'main' | 'history';

type ListSelection = {
  key: string | null;
  occurrence: number;
  index: number;
};

type ArchivedStatus = 'merged' | 'completed' | 'failed' | 'stopped';

type ArchivedHistoryEntry = {
  key: string;
  branch: string;
  description: string;
  status: string;
  completedAtMs: number;
  project?: string;
  lastError?: string;
  currentStoryId?: string;
  currentStep?: string;
  reconcileReason?: string;
  retryCount?: number;
};

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
  private runnerStatus: 'running' | 'stopped' | 'crashed' = 'stopped';
  private runnerError: string | null = null;
  private viewMode: ViewMode = 'main';
  private mainSelection: ListSelection = { key: null, occurrence: 0, index: 0 };
  private historySelection: ListSelection = { key: null, occurrence: 0, index: 0 };
  private historyEntries: ArchivedHistoryEntry[] = [];

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
      content: ' q: quit | h: history | ↑↓: navigate | Enter: expand',
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
    this.screen.key(['C-c'], () => process.exit(0));

    this.screen.key(['q'], () => {
      if (this.viewMode === 'history') {
        this.showMainView();
        return;
      }
      process.exit(0);
    });

    this.screen.key(['escape'], () => {
      if (this.viewMode === 'history') {
        this.showMainView();
      }
    });

    this.screen.key(['h', 'a'], () => {
      if (this.viewMode === 'main') {
        this.showHistoryView();
      }
    });

    this.screen.key(['r'], () => {
      this.refresh();
    });

    this.screen.key(['t'], () => {
      this.retrySelected();
    });

    this.screen.key(['space'], () => {
      this.toggleExpand();
    });

    this.executionList.key(['enter'], () => {
      this.toggleExpand();
    });

    // Update detail panel when selection changes
    this.executionList.on('select item', () => {
      this.updateDetailPanel();
    });

    // Also handle up/down/j/k navigation
    this.executionList.key(['up', 'down', 'j', 'k'], () => {
      // Small delay to let blessed update the selection first
      setImmediate(() => {
        this.updateDetailPanel();
      });
    });
  }

  setRunnerStatus(status: 'running' | 'stopped' | 'crashed', error: string | null): void {
    this.runnerStatus = status;
    this.runnerError = error;
  }

  private updateDetailPanel() {
    const state = this.stateLoader.loadState();
    if (this.viewMode === 'history') {
      this.updateHistoryLogs(state);
    } else {
      this.updateLogs(state);
    }
    this.screen.render();
  }

  private toggleExpand() {
    if (this.viewMode !== 'main') return;
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

  /**
   * Retry the selected failed execution.
   * Directly updates state file to set status to 'ready' and reset stagnation counters.
   */
  private retrySelected() {
    if (this.viewMode !== 'main') return;
    const state = this.stateLoader.loadState();
    const executions = this.getExecutions(state);
    const selected = (this.executionList as any).selected || 0;
    const selectedBranch = this.executionRowBranches[selected];

    if (!selectedBranch) {
      this.showMessage('No execution selected', 'yellow');
      return;
    }

    const selectedExec = executions.find(e => e.branch === selectedBranch);
    if (!selectedExec) {
      this.showMessage('Execution not found', 'red');
      return;
    }

    const status = ((selectedExec as any).status as string | undefined)?.toLowerCase();
    if (status !== 'failed' && status !== 'stopped') {
      this.showMessage(`Cannot retry: status is '${status}' (need 'failed' or 'stopped')`, 'yellow');
      return;
    }

    this.showMessage(`Retrying ${this.stripRalphPrefix(selectedBranch)}...`, 'cyan');

    try {
      // Directly update state file
      const RALPH_DATA_DIR = process.env.RALPH_DATA_DIR?.replace('~', homedir()) || join(homedir(), '.ralph');
      const statePath = join(RALPH_DATA_DIR, 'state.json');
      const stateData = JSON.parse(readFileSync(statePath, 'utf-8'));

      // Find and update the execution
      const execIndex = stateData.executions.findIndex((e: any) => e.branch === selectedBranch);
      if (execIndex === -1) {
        this.showMessage('Execution not found in state file', 'red');
        return;
      }

      // Update execution status and reset stagnation counters
      stateData.executions[execIndex].status = 'ready';
      stateData.executions[execIndex].lastError = null;
      stateData.executions[execIndex].launchAttempts = 0;
      stateData.executions[execIndex].consecutiveNoProgress = 0;
      stateData.executions[execIndex].consecutiveErrors = 0;
      stateData.executions[execIndex].updatedAt = new Date().toISOString();

      // Write back
      writeFileSync(statePath, JSON.stringify(stateData, null, 2));

      this.showMessage(`Retry initiated: ${this.stripRalphPrefix(selectedBranch)} set to 'ready'`, 'green');
    } catch (error) {
      this.showMessage(`Retry error: ${error instanceof Error ? error.message : String(error)}`, 'red');
    }

    // Refresh after a short delay to show updated status
    setTimeout(() => this.refresh(), 300);
  }

  /**
   * Show a temporary message in the log box.
   */
  private showMessage(message: string, color: string = 'white') {
    const coloredMessage = `{${color}-fg}${message}{/${color}-fg}`;
    this.logBox.setContent(coloredMessage);
    this.screen.render();
  }

  refresh(restoreSelection: boolean = false) {
    const state = this.stateLoader.loadState();
    this.updateStatusBar();
    if (this.viewMode === 'history') {
      this.updateHistoryOverview();
      this.updateHistoryList(state, restoreSelection ? this.historySelection : undefined);
      this.updateHistoryLogs(state);
    } else {
      this.updateOverview(state);
      this.updateExecutionList(state, restoreSelection ? this.mainSelection : undefined);
      this.updateLogs(state);
    }
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

    const trueFailCount = this.getTrueFailedArchivedPrdCount(state);

    // Runner status indicator
    let runnerIndicator: string;
    switch (this.runnerStatus) {
      case 'running':
        runnerIndicator = '{green-fg}Runner: ON{/green-fg}';
        break;
      case 'crashed':
        runnerIndicator = `{red-fg}Runner: CRASHED{/red-fg}${this.runnerError ? ` (${this.runnerError})` : ''}`;
        break;
      default:
        runnerIndicator = '{gray-fg}Runner: OFF{/gray-fg}';
    }

    const content = [
      `{cyan-fg}{bold}Ralph MCP Monitor{/bold}{/cyan-fg}  ${runnerIndicator}`,
      `PRDs: {yellow-fg}${counts.RUN} run{/yellow-fg} | {blue-fg}${counts.MRG} merge{/blue-fg} | {gray-fg}${counts.WAIT} wait{/gray-fg} | {red-fg}${trueFailCount} fail{/red-fg}`,
      progress.total === 0
        ? `Stories: {gray-fg}parsing...{/gray-fg}`
        : `Stories: {green-fg}${progress.done}/${progress.total}{/green-fg} done (${Math.round(progress.done / progress.total * 100)}%)`
    ].join('\n');

    this.overviewBox.setContent(content);
  }

  private getTrueFailedArchivedPrdCount(state: RalphState): number {
    const archived = (state as any).archivedExecutions;
    if (!Array.isArray(archived) || archived.length === 0) return 0;

    const normalizedKey = (e: any): string => {
      const project = typeof e?.project === 'string' ? e.project : '';
      const branch = typeof e?.branch === 'string' ? e.branch : '';
      return `${project}::${branch}`;
    };

    const isSuccessStatus = (status: string): boolean => {
      const normalized = status.trim().toLowerCase();
      return normalized === 'merged';
    };

    const mergedKeys = new Set<string>();
    for (const entry of archived) {
      const status = typeof entry?.status === 'string' ? entry.status : '';
      if (!status) continue;
      if (isSuccessStatus(status)) mergedKeys.add(normalizedKey(entry));
    }

    const failedKeys = new Set<string>();
    for (const entry of archived) {
      const status = typeof entry?.status === 'string' ? entry.status : '';
      if (!status) continue;
      const normalized = status.trim().toLowerCase();
      if (normalized !== 'failed') continue;

      const key = normalizedKey(entry);
      if (!mergedKeys.has(key)) failedKeys.add(key);
    }

    return failedKeys.size;
  }

  private updateExecutionList(state: RalphState, previousSelection?: ListSelection) {
    const executions = this.getExecutions(state);
    const previous = previousSelection ?? this.captureListSelection();
    const previousSelected = previous.index;
    const previousBranch = previous.key;
    const previousOccurrence = previous.occurrence;
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

      const metricsShort = this.getShortMetrics(exec);
      items.push(`${expandIcon} ${statusIcon} {bold}${branchName}{/bold} ${progressLabel}${metricsShort ? ` ${metricsShort}` : ''}`);
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
      const nextSelected = this.restoreListSelection(rowBranches, items.length, {
        key: previousBranch,
        occurrence: previousOccurrence,
        index: previousSelected,
      });
      this.executionList.select(nextSelected);
    }
  }

  private updateHistoryOverview() {
    this.overviewBox.setContent('{cyan-fg}{bold}Archived PRDs{/bold}{/cyan-fg}');
  }

  private updateHistoryList(state: RalphState, previousSelection?: ListSelection) {
    const previous = previousSelection ?? this.captureListSelection();
    const items: string[] = [];
    const rowKeys: string[] = [];

    const entries = this.getArchivedHistory(state, Number.MAX_SAFE_INTEGER);
    this.historyEntries = entries;

    entries.forEach(entry => {
      const badge = this.formatArchivedStatusBadge(entry.status);
      const branch = this.stripRalphPrefix(entry.branch);
      const description = entry.description ? this.truncateText(entry.description.trim(), 72) : '(no description)';
      const completedAt = entry.completedAtMs > 0 ? this.formatLocalDateTime(entry.completedAtMs) : 'unknown';
      const status = entry.status.trim().toLowerCase();
      const timeLabel = status === 'failed' ? 'failed' : status === 'stopped' ? 'stopped' : 'completed';

      const parts: string[] = [];
      parts.push(`${badge} ${branch} - ${description} (${timeLabel}: ${completedAt})`);

      const retryCount = entry.retryCount ?? 0;
      if (false && (status === 'merged' || status === 'completed') && retryCount > 0) {
        parts.push(`{gray-fg}[重试: ${retryCount}次]{/gray-fg}`);
      }

      if (false && (status === 'merged' || status === 'completed') && retryCount > 0) {
        parts.push(`{gray-fg}[重试: ${retryCount}次]{/gray-fg}`);
      }

      if ((status === 'merged' || status === 'completed') && retryCount > 0) {
        parts.push(`{gray-fg}[\u91cd\u8bd5: ${retryCount}\u6b21]{/gray-fg}`);
      }

      if (false && (status === 'failed' || status === 'stopped')) {
        const reason = this.getArchivedFailureReason(entry);
        const reasonLabel = status === 'stopped' ? '原因' : '原因';
        parts.push(`{gray-fg}[${reasonLabel}: ${this.truncateText(reason, 80)}]{/gray-fg}`);
      }

      if (false && (status === 'failed' || status === 'stopped')) {
        const reason = this.getArchivedFailureReason(entry);
        parts.push(`{gray-fg}[原因: ${this.truncateText(reason, 80)}]{/gray-fg}`);
      }

      if (status === 'failed' || status === 'stopped') {
        const reason = this.getArchivedFailureReason(entry);
        parts.push(`{gray-fg}[\u539f\u56e0: ${this.truncateText(reason, 80)}]{/gray-fg}`);
      }

      items.push(parts.join(' '));
      rowKeys.push(entry.key);
    });

    if (items.length === 0) {
      items.push('{gray-fg}No archived PRDs found yet.{/gray-fg}');
    }

    this.executionRowBranches = rowKeys;
    this.executionList.setItems(items);

    if (items.length > 0) {
      const nextSelected = this.restoreListSelection(rowKeys, items.length, previous);
      this.executionList.select(nextSelected);
    }
  }

  private updateHistoryLogs(state: RalphState) {
    const entries = this.historyEntries.length > 0 ? this.historyEntries : this.getArchivedHistory(state, Number.MAX_SAFE_INTEGER);
    const selected = (this.executionList as any).selected || 0;
    const selectedKey = this.executionRowBranches[selected];
    const selectedEntry = selectedKey ? entries.find(e => e.key === selectedKey) : entries[selected];

    const lines: string[] = [];

    if (!selectedEntry) {
      lines.push('No archived PRDs. Press Esc to go back.');
      this.logBox.setContent(lines.join('\n'));
      return;
    }

    const branch = this.stripRalphPrefix(selectedEntry.branch);
    const badge = this.formatArchivedStatusBadge(selectedEntry.status);
    const completedAt = selectedEntry.completedAtMs > 0 ? this.formatLocalDateTime(selectedEntry.completedAtMs) : 'unknown';
    const status = selectedEntry.status.trim().toLowerCase();
    const timeLabel = status === 'failed' ? 'Failed' : status === 'stopped' ? 'Stopped' : 'Completed';

    lines.push(`{bold}${branch}{/bold}`);
    lines.push(`Status: ${badge}`);
    lines.push(`${timeLabel}: ${completedAt}`);

    const retryCount = selectedEntry.retryCount ?? 0;
    if ((status === 'merged' || status === 'completed') && retryCount > 0) {
      lines.push(`Retries: ${retryCount}`);
    }

    if (status === 'failed' || status === 'stopped') {
      lines.push(`Reason: ${this.getArchivedFailureReason(selectedEntry)}`);
    }
    if (selectedEntry.description) {
      lines.push('');
      lines.push(`{gray-fg}${selectedEntry.description.trim()}{/gray-fg}`);
    }

    this.logBox.setContent(lines.join('\n'));
  }

  private updateStatusBar() {
    if (this.viewMode === 'history') {
      this.statusBar.setContent(' Esc: back | ↑↓: navigate');
      return;
    }
    this.statusBar.setContent(' q: quit | h: history | ↑↓: navigate | Enter: expand');
  }

  private showHistoryView() {
    this.mainSelection = this.captureListSelection();
    this.viewMode = 'history';
    this.refresh(true);
  }

  private showMainView() {
    this.historySelection = this.captureListSelection();
    this.viewMode = 'main';
    this.refresh(true);
  }

  private captureListSelection(): ListSelection {
    const selected = (this.executionList as any).selected || 0;
    const key = this.executionRowBranches[selected] ?? null;
    const occurrence = key ? this.executionRowBranches.slice(0, selected).filter(b => b === key).length : 0;
    return { key, occurrence, index: selected };
  }

  private restoreListSelection(rowKeys: string[], itemsLength: number, previous: ListSelection): number {
    const maxIndex = Math.max(0, itemsLength - 1);
    let nextSelected = Math.max(0, Math.min(previous.index, maxIndex));

    if (!previous.key) return nextSelected;

    let occurrence = 0;
    for (let i = 0; i < rowKeys.length; i++) {
      if (rowKeys[i] !== previous.key) continue;
      if (occurrence === previous.occurrence) {
        nextSelected = i;
        break;
      }
      occurrence++;
    }

    return Math.max(0, Math.min(nextSelected, maxIndex));
  }

  private getArchivedHistory(state: RalphState, limit: number): ArchivedHistoryEntry[] {
    const historyLike = (state as any).history;
    if (Array.isArray(historyLike)) {
      const parsed = historyLike
        .filter((e: any) => e && typeof e.branch === 'string')
        .map((e: any) => {
          const completedAtMs = this.parseTimestamp(e.mergedAt || e.updatedAt || e.createdAt);
          const key = `${e.branch}::${e.mergedAt || e.updatedAt || e.createdAt || ''}`;
          return {
            key,
            branch: e.branch,
            description: typeof e.description === 'string' ? e.description : '',
            status: typeof e.status === 'string' ? e.status : '',
            completedAtMs,
            project: typeof e.project === 'string' ? e.project : undefined,
            retryCount: 0,
          };
        })

      this.populateArchivedRetryCounts(parsed);
      parsed.sort((a, b) => b.completedAtMs - a.completedAtMs);
      return parsed.slice(0, limit);
    }

    const archived = (state as any).archivedExecutions;
    if (!Array.isArray(archived)) return [];

    const parsed = archived
      .filter((e: any) => e && typeof e.branch === 'string')
      .map((e: any) => {
        const completedAtMs = this.parseTimestamp(e.mergedAt || e.updatedAt || e.createdAt);
        const key = `${typeof e.id === 'string' ? e.id : e.branch}::${e.mergedAt || e.updatedAt || e.createdAt || ''}`;
        return {
          key,
          branch: e.branch,
          description: typeof e.description === 'string' ? e.description : '',
          status: typeof e.status === 'string' ? e.status : '',
          completedAtMs,
          project: typeof e.project === 'string' ? e.project : undefined,
          lastError: typeof e.lastError === 'string' ? e.lastError : undefined,
          currentStoryId: typeof e.currentStoryId === 'string' ? e.currentStoryId : undefined,
          currentStep: typeof e.currentStep === 'string' ? e.currentStep : undefined,
          reconcileReason: typeof e.reconcileReason === 'string' ? e.reconcileReason : undefined,
          retryCount: 0,
        };
      });

    this.populateArchivedRetryCounts(parsed);
    parsed.sort((a, b) => b.completedAtMs - a.completedAtMs);
    return parsed.slice(0, limit);
  }

  private populateArchivedRetryCounts(entries: ArchivedHistoryEntry[]): void {
    if (entries.length === 0) return;

    const isSuccessStatus = (status: string): boolean => {
      const normalized = status.trim().toLowerCase();
      return normalized === 'merged' || normalized === 'completed' || normalized === 'succeeded' || normalized === 'success';
    };

    const isFailedStatus = (status: string): boolean => {
      const normalized = status.trim().toLowerCase();
      return normalized === 'failed';
    };

    const groups = new Map<string, ArchivedHistoryEntry[]>();
    for (const entry of entries) {
      const project = entry.project ?? '';
      const key = `${project}::${entry.branch}`;
      const bucket = groups.get(key);
      if (bucket) bucket.push(entry);
      else groups.set(key, [entry]);
    }

    for (const group of groups.values()) {
      const failedCount = group.reduce((acc, entry) => acc + (isFailedStatus(entry.status || '') ? 1 : 0), 0);
      for (const entry of group) {
        if (isSuccessStatus(entry.status || '')) {
          entry.retryCount = failedCount;
        } else {
          entry.retryCount = entry.retryCount ?? 0;
        }
      }
    }
  }

  private getArchivedFailureReason(entry: ArchivedHistoryEntry): string {
    if (entry.lastError && entry.lastError.trim().length > 0) return entry.lastError.trim();

    const parts: string[] = [];
    if (entry.currentStoryId) parts.push(entry.currentStoryId);
    if (entry.currentStep) parts.push(entry.currentStep);
    if (parts.length > 0) return `at ${parts.join(' ')}`;

    if (entry.reconcileReason && entry.reconcileReason.trim().length > 0) return entry.reconcileReason.trim();

    return 'unknown';
  }

  private formatArchivedStatusBadge(status: string): string {
    const normalized = status.trim().toLowerCase();
    const label = normalized.length > 0 ? normalized.toUpperCase() : 'UNKNOWN';

    const color = (() => {
      switch (normalized as ArchivedStatus) {
        case 'merged': return 'green';
        case 'completed': return 'blue';
        case 'failed': return 'red';
        case 'stopped': return 'yellow';
        default: return 'gray';
      }
    })();

    return `{${color}-fg}[${label}]{/${color}-fg}`;
  }

  private formatLocalDateTime(timestampMs: number): string {
    const d = new Date(timestampMs);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  private updateLogs(state: RalphState) {
    const executions = this.getExecutions(state);
    const logs: string[] = [];

    // Get currently selected execution
    const selected = (this.executionList as any).selected || 0;
    const selectedBranch = this.executionRowBranches[selected];
    const selectedExec = selectedBranch
      ? executions.find(e => e.branch === selectedBranch)
      : undefined;

    if (selectedExec) {
      // Show details for selected execution
      const branchName = this.stripRalphPrefix(selectedExec.branch);
      const statusIcon = this.getStatusIcon(selectedExec, state);
      const progressLabel = this.formatExecutionProgress(selectedExec, state);
      const logActivity = this.getLogActivity(selectedExec);
      const activityIndicator = logActivity ? ` [${logActivity}]` : '';

      logs.push(`{bold}Selected: ${branchName}{/bold}`);
      logs.push(`Status: ${statusIcon} ${progressLabel}${activityIndicator}`);

      // Show description if available
      const description = (selectedExec as any).description;
      if (typeof description === 'string' && description.trim().length > 0) {
        logs.push(`{gray-fg}${this.truncateText(description.trim(), 120)}{/gray-fg}`);
      }

      logs.push('');

      // Show current activity
      const currentActivity = this.getCurrentActivity(selectedExec);
      if (currentActivity) {
        logs.push(`{cyan-fg}Current:{/cyan-fg} ${currentActivity}`);
      }

      // Show metrics
      const metrics = this.getExecutionMetrics(selectedExec);
      if (metrics) logs.push(`{cyan-fg}Metrics:{/cyan-fg} ${metrics}`);

      // Show worktree path
      const worktreePath = (selectedExec as any).worktreePath;
      if (typeof worktreePath === 'string') {
        logs.push(`{cyan-fg}Path:{/cyan-fg} ${worktreePath}`);
      }

      // Show agent task ID
      const agentTaskId = (selectedExec as any).agentTaskId;
      if (typeof agentTaskId === 'string') {
        logs.push(`{cyan-fg}Agent:{/cyan-fg} ${agentTaskId}`);
      }

      // Show last error if any
      const lastError = (selectedExec as any).lastError;
      if (typeof lastError === 'string' && lastError.trim().length > 0) {
        logs.push('');
        logs.push(`{red-fg}Error:{/red-fg} ${this.truncateText(lastError.trim(), 200)}`);
      }

      // Show user stories summary
      const stories = this.getExecutionStories(selectedExec, state);
      if (stories.length > 0) {
        logs.push('');
        const done = stories.filter(s => this.isStoryDone(s)).length;
        const running = stories.filter(s => this.getStoryStatus(s) === 'running').length;
        const pending = stories.length - done - running;
        logs.push(`{cyan-fg}Stories:{/cyan-fg} {green-fg}${done} done{/green-fg} | {yellow-fg}${running} running{/yellow-fg} | {gray-fg}${pending} pending{/gray-fg}`);

        // Show latest completed story
        const latestDone = stories.filter(s => this.isStoryDone(s)).slice(-1)[0];
        if (latestDone) {
          const storyId = this.getStoryId(latestDone);
          const title = this.getStoryTitle(latestDone, storyId);
          logs.push(`{cyan-fg}Latest:{/cyan-fg} {green-fg}${storyId}{/green-fg} ${title}`);
        }
      }
    } else {
      // Fallback: show summary when nothing selected
      const activeExecutions = executions
        .filter(e => {
          const displayStatus = this.getDisplayStatus(e, state);
          return displayStatus === 'RUN' || displayStatus === 'MRG';
        })
        .slice(0, 3);

      if (activeExecutions.length > 0) {
        logs.push('{bold}Active executions{/bold}');
        activeExecutions.forEach(exec => {
          const branchName = this.stripRalphPrefix(exec.branch);
          const statusIcon = this.getStatusIcon(exec, state);
          const progressLabel = this.formatExecutionProgress(exec, state);
          logs.push(`${statusIcon} {bold}${branchName}{/bold} ${progressLabel}`);
        });
      } else {
        logs.push('No execution selected. Use Up/Down to navigate.');
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

    if (typeof loopCount === 'number' && loopCount > 0) parts.push(`loops:${loopCount}`);
    if (typeof noProgress === 'number' && noProgress > 0) parts.push(`{yellow-fg}no-progress:${noProgress}{/yellow-fg}`);
    if (typeof errors === 'number' && errors > 0) parts.push(`{red-fg}errors:${errors}{/red-fg}`);
    if (typeof files === 'number' && files > 0) parts.push(`files:${files}`);

    return parts.length > 0 ? parts.join(' | ') : undefined;
  }

  private getShortMetrics(exec: RalphExecution): string {
    const parts: string[] = [];

    // Add activity/stale indicator for running/merging executions
    const status = ((exec as any).status as string | undefined)?.toLowerCase();
    if (status === 'running' || status === 'starting' || status === 'merging') {
      const activity = this.getLogActivity(exec);
      if (activity) {
        parts.push(activity);
      }
    }

    const loopCount = (exec as any).loopCount;
    const noProgress = (exec as any).consecutiveNoProgress;
    const errors = (exec as any).consecutiveErrors;

    if (typeof loopCount === 'number' && loopCount > 0) {
      parts.push(`L${loopCount}`);
    }
    if (typeof noProgress === 'number' && noProgress > 0) {
      parts.push(`{yellow-fg}NP${noProgress}{/yellow-fg}`);
    }
    if (typeof errors === 'number' && errors > 0) {
      parts.push(`{red-fg}E${errors}{/red-fg}`);
    }

    return parts.length > 0 ? `{gray-fg}(${parts.join('/')}){/gray-fg}` : '';
  }

  private getCurrentActivity(exec: RalphExecution): string | undefined {
    const currentStoryId = (exec as any).currentStoryId;
    const currentStep = (exec as any).currentStep;
    const stepStartedAt = (exec as any).stepStartedAt;

    if (!currentStoryId && !currentStep) return undefined;

    const parts: string[] = [];

    if (currentStoryId) {
      parts.push(`{bold}${currentStoryId}{/bold}`);
    }

    if (currentStep) {
      parts.push(currentStep);
    }

    if (stepStartedAt) {
      const ms = this.parseTimestamp(stepStartedAt);
      if (ms > 0) {
        const elapsed = this.formatElapsed(ms);
        parts.push(`{gray-fg}(${elapsed}){/gray-fg}`);
      }
    }

    return parts.length > 0 ? parts.join(' ') : undefined;
  }

  private formatElapsed(startMs: number): string {
    const deltaSec = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
    if (deltaSec < 60) return `${deltaSec}s`;
    const deltaMin = Math.floor(deltaSec / 60);
    const remainSec = deltaSec % 60;
    if (deltaMin < 60) return `${deltaMin}m${remainSec}s`;
    const deltaHr = Math.floor(deltaMin / 60);
    const remainMin = deltaMin % 60;
    return `${deltaHr}h${remainMin}m`;
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

  /**
   * Get activity status based on log file mtime.
   * Returns colored status indicator.
   */
  private getLogActivity(exec: RalphExecution): string | undefined {
    const logPath = (exec as any).logPath;
    if (!logPath) return undefined;

    try {
      const stat = statSync(logPath);
      const mtime = stat.mtimeMs;
      const age = Date.now() - mtime;

      if (age < 5000) return '{green-fg}active{/green-fg}';
      if (age < 30000) return `{yellow-fg}${Math.floor(age / 1000)}s{/yellow-fg}`;
      if (age < 120000) return `{red-fg}${Math.floor(age / 1000)}s{/red-fg}`;
      if (age < 300000) return `{red-fg}${Math.floor(age / 60000)}m{/red-fg}`;
      return '{red-fg}stale{/red-fg}';
    } catch {
      return undefined;
    }
  }

  render() {
    this.screen.render();
  }
}
