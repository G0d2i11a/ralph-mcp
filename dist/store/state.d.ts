export declare const RALPH_DATA_DIR: string;
export type ExecutionStatus = "pending" | "running" | "completed" | "failed" | "stopped" | "merging";
export type ConflictStrategy = "auto_theirs" | "auto_ours" | "notify" | "agent";
export interface ExecutionRecord {
    id: string;
    project: string;
    branch: string;
    description: string;
    prdPath: string;
    projectRoot: string;
    worktreePath: string | null;
    status: ExecutionStatus;
    agentTaskId: string | null;
    onConflict: ConflictStrategy | null;
    autoMerge: boolean;
    notifyOnComplete: boolean;
    createdAt: Date;
    updatedAt: Date;
}
export interface UserStoryRecord {
    id: string;
    executionId: string;
    storyId: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    priority: number;
    passes: boolean;
    notes: string;
}
export type MergeQueueStatus = "pending" | "merging" | "completed" | "failed";
export interface MergeQueueItem {
    id: number;
    executionId: string;
    position: number;
    status: MergeQueueStatus;
    createdAt: Date;
}
export declare function listExecutions(): Promise<ExecutionRecord[]>;
export declare function findExecutionByBranch(branch: string): Promise<ExecutionRecord | null>;
export declare function findExecutionById(executionId: string): Promise<ExecutionRecord | null>;
export declare function insertExecution(execution: ExecutionRecord): Promise<void>;
export declare function updateExecution(executionId: string, patch: Partial<Omit<ExecutionRecord, "id" | "createdAt">> & {
    updatedAt?: Date;
}): Promise<void>;
export declare function deleteExecution(executionId: string): Promise<void>;
export declare function listUserStoriesByExecutionId(executionId: string): Promise<UserStoryRecord[]>;
export declare function findUserStoryById(storyKey: string): Promise<UserStoryRecord | null>;
export declare function insertUserStories(stories: UserStoryRecord[]): Promise<void>;
export declare function updateUserStory(storyKey: string, patch: Partial<Omit<UserStoryRecord, "id" | "executionId" | "storyId">>): Promise<void>;
export declare function listMergeQueue(): Promise<MergeQueueItem[]>;
export declare function findMergeQueueItemByExecutionId(executionId: string): Promise<MergeQueueItem | null>;
export declare function insertMergeQueueItem(item: Omit<MergeQueueItem, "id">): Promise<MergeQueueItem>;
export declare function updateMergeQueueItem(id: number, patch: Partial<Omit<MergeQueueItem, "id" | "executionId" | "createdAt">>): Promise<void>;
export declare function deleteMergeQueueByExecutionId(executionId: string): Promise<void>;
