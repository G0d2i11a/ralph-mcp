import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
export const executions = sqliteTable("executions", {
    id: text("id").primaryKey(),
    project: text("project").notNull(),
    branch: text("branch").notNull().unique(),
    description: text("description").notNull(),
    prdPath: text("prd_path").notNull(),
    projectRoot: text("project_root").notNull(),
    worktreePath: text("worktree_path"),
    status: text("status", {
        enum: ["pending", "running", "completed", "failed", "stopped", "merging"],
    })
        .notNull()
        .default("pending"),
    agentTaskId: text("agent_task_id"),
    onConflict: text("on_conflict", {
        enum: ["auto_theirs", "auto_ours", "notify", "agent"],
    }).default("agent"),
    autoMerge: integer("auto_merge", { mode: "boolean" }).notNull().default(false),
    notifyOnComplete: integer("notify_on_complete", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .$defaultFn(() => new Date()),
});
export const userStories = sqliteTable("user_stories", {
    id: text("id").primaryKey(), // composite: executionId + storyId
    executionId: text("execution_id")
        .notNull()
        .references(() => executions.id, { onDelete: "cascade" }),
    storyId: text("story_id").notNull(), // "US-001"
    title: text("title").notNull(),
    description: text("description").notNull(),
    acceptanceCriteria: text("acceptance_criteria", { mode: "json" })
        .notNull()
        .$type(),
    priority: integer("priority").notNull(),
    passes: integer("passes", { mode: "boolean" }).notNull().default(false),
    notes: text("notes").default(""),
});
export const mergeQueue = sqliteTable("merge_queue", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    executionId: text("execution_id")
        .notNull()
        .references(() => executions.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    status: text("status", {
        enum: ["pending", "merging", "completed", "failed"],
    })
        .notNull()
        .default("pending"),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .$defaultFn(() => new Date()),
});
