import blessed from 'blessed';
import { RalphState, RalphExecution } from './types';
import { StateLoader } from './state-loader';

export class MonitorUI {
  private screen: blessed.Widgets.Screen;
  private overviewBox!: blessed.Widgets.BoxElement;
  private executionList!: blessed.Widgets.ListElement;
  private logBox!: blessed.Widgets.BoxElement;
  private statusBar!: blessed.Widgets.TextElement;
  private stateLoader: StateLoader;
  private selectedIndex: number = 0;
  private expandedBranches: Set<string> = new Set();

  constructor(stateLoader: StateLoader) {
    this.stateLoader = stateLoader;
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Ralph MCP Monitor'
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
      keys: true,
      vi: true,
      mouse: true,
      scrollbar: {
        ch: '█',
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
        ch: '█',
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
      content: ' [q]uit [r]efresh [space]expand/collapse [↑↓]navigate',
      style: {
        bg: 'blue',
        fg: 'white'
      }
    });

    this.screen.append(this.overviewBox);
    this.screen.append(this.executionList);
    this.screen.append(this.logBox);
    this.screen.append(this.statusBar);
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
    const state = this.stateLoader.loadState();
    const executions = Object.values(state.executions);
    const selected = (this.executionList as any).selected || 0;

    if (selected >= executions.length) return;

    const execution = executions[selected];
    if (this.expandedBranches.has(execution.branch)) {
      this.expandedBranches.delete(execution.branch);
    } else {
      this.expandedBranches.add(execution.branch);
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
    const stats = this.stateLoader.getExecutionStats(state);
    const progress = this.stateLoader.getStoryProgress(state);

    const content = [
      `{cyan-fg}{bold}Ralph MCP Monitor{/bold}{/cyan-fg}  {gray-fg}State: ${this.stateLoader.getStateFilePath()}{/gray-fg}`,
      `PRDs: {green-fg}${stats.completed} completed{/green-fg} | {yellow-fg}${stats.running} running{/yellow-fg} | {red-fg}${stats.failed} failed{/red-fg} | {blue-fg}${stats.merging} merging{/blue-fg}`,
      `Stories: {green-fg}${progress.completed}/${progress.total}{/green-fg} (${progress.total > 0 ? Math.round(progress.completed / progress.total * 100) : 0}%)`
    ].join('\n');

    this.overviewBox.setContent(content);
  }

  private updateExecutionList(state: RalphState) {
    const executions = Object.values(state.executions);
    const items: string[] = [];

    executions.forEach(exec => {
      const statusIcon = this.getStatusIcon(exec.status);
      const branchName = exec.branch.replace('ralph/', '');
      const storyProgress = `${exec.userStories.filter(s => s.status === 'passed').length}/${exec.userStories.length}`;

      const isExpanded = this.expandedBranches.has(exec.branch);
      const expandIcon = isExpanded ? '▼' : '▶';

      items.push(`${expandIcon} ${statusIcon} {bold}${branchName}{/bold} [${storyProgress}]`);

      if (isExpanded) {
        exec.userStories.forEach((story, idx) => {
          const storyIcon = this.getStoryIcon(story.status);
          const storyTitle = story.title || story.id;
          items.push(`    ${storyIcon} ${story.id}: ${storyTitle}`);
        });
      }
    });

    if (items.length === 0) {
      items.push('{gray-fg}No executions found. Start a PRD with ralph_start.{/gray-fg}');
    }

    this.executionList.setItems(items);
  }

  private updateLogs(state: RalphState) {
    const executions = Object.values(state.executions)
      .filter(e => e.status === 'running')
      .slice(0, 5);

    const logs: string[] = [];

    if (executions.length === 0) {
      logs.push('{gray-fg}No active executions{/gray-fg}');
    } else {
      executions.forEach(exec => {
        const currentStory = exec.userStories[exec.currentStoryIndex];
        if (currentStory) {
          logs.push(`{cyan-fg}[${exec.branch.replace('ralph/', '')}]{/cyan-fg} ${currentStory.id}: ${currentStory.status}`);
          if (currentStory.notes) {
            logs.push(`  {gray-fg}${currentStory.notes.slice(0, 100)}...{/gray-fg}`);
          }
        }
      });
    }

    this.logBox.setContent(logs.join('\n'));
  }

  private getStatusIcon(status: string): string {
    switch (status) {
      case 'running': return '{yellow-fg}🔄{/yellow-fg}';
      case 'completed': return '{green-fg}✅{/green-fg}';
      case 'merged': return '{green-fg}✅{/green-fg}';
      case 'failed': return '{red-fg}❌{/red-fg}';
      case 'merging': return '{blue-fg}🔀{/blue-fg}';
      default: return '{gray-fg}⏳{/gray-fg}';
    }
  }

  private getStoryIcon(status: string): string {
    switch (status) {
      case 'running': return '{yellow-fg}▶{/yellow-fg}';
      case 'passed': return '{green-fg}✓{/green-fg}';
      case 'failed': return '{red-fg}✗{/red-fg}';
      default: return '{gray-fg}○{/gray-fg}';
    }
  }

  render() {
    this.screen.render();
  }
}
