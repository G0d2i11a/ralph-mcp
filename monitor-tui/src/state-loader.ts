import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RalphState } from './types';

export class StateLoader {
  private stateFilePath: string;

  constructor() {
    const dataDir = process.env.RALPH_DATA_DIR || path.join(os.homedir(), '.ralph');
    this.stateFilePath = path.join(dataDir, 'state.json');
  }

  getStateFilePath(): string {
    return this.stateFilePath;
  }

  loadState(): RalphState {
    try {
      if (!fs.existsSync(this.stateFilePath)) {
        return { executions: {}, mergeQueue: [] };
      }

      const content = fs.readFileSync(this.stateFilePath, 'utf-8');
      return JSON.parse(content) as RalphState;
    } catch (error) {
      console.error('Failed to load state:', error);
      return { executions: {}, mergeQueue: [] };
    }
  }

  getExecutionStats(state: RalphState) {
    const executions = Object.values(state.executions);

    return {
      total: executions.length,
      running: executions.filter(e => e.status === 'running').length,
      completed: executions.filter(e => e.status === 'completed' || e.status === 'merged').length,
      failed: executions.filter(e => e.status === 'failed').length,
      merging: executions.filter(e => e.status === 'merging').length,
    };
  }

  getStoryProgress(state: RalphState) {
    const executions = Object.values(state.executions);
    let totalStories = 0;
    let completedStories = 0;

    executions.forEach(exec => {
      totalStories += exec.userStories.length;
      completedStories += exec.userStories.filter(s => s.status === 'passed').length;
    });

    return { total: totalStories, completed: completedStories };
  }
}
