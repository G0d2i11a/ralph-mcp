export interface UserStory {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'passed' | 'failed';
  startedAt?: string;
  completedAt?: string;
  notes?: string;
}

export interface RalphExecution {
  branch: string;
  prdPath: string;
  status: 'running' | 'completed' | 'failed' | 'merging' | 'merged';
  userStories: UserStory[];
  startedAt: string;
  completedAt?: string;
  currentStoryIndex: number;
  agentTaskId?: string;
  mergeQueuePosition?: number;
}

export interface RalphState {
  executions: Record<string, RalphExecution>;
  mergeQueue: string[];
}
