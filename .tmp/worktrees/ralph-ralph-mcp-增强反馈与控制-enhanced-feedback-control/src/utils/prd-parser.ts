import { readFileSync } from "fs";
import matter from "gray-matter";

export interface ParsedUserStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: number;
}

export interface StorySizeWarning {
  storyId: string;
  title: string;
  issues: string[];
  acCount: number;
  descriptionLength: number;
  suggestedSplits?: string[];
}

export interface StorySizeAnalysis {
  hasOversizedStories: boolean;
  warnings: StorySizeWarning[];
}

export interface ParsedPrd {
  title: string;
  description: string;
  branchName: string;
  userStories: ParsedUserStory[];
  dependencies: string[]; // Branch names this PRD depends on
}

/**
 * Parse a PRD markdown file into structured data.
 * Supports both markdown format and JSON format.
 */
export function parsePrdFile(filePath: string): ParsedPrd {
  const content = readFileSync(filePath, "utf-8");

  // Check if it's JSON format
  if (filePath.endsWith(".json")) {
    return parsePrdJson(content);
  }

  return parsePrdMarkdown(content);
}

function parsePrdJson(content: string): ParsedPrd {
  const data = JSON.parse(content);
  return {
    title: data.description || data.title || "Untitled PRD",
    description: data.description || "",
    branchName: data.branchName || "ralph/unnamed",
    userStories: (data.userStories || []).map(
      (us: Record<string, unknown>, index: number) => ({
        id: (us.id as string) || `US-${String(index + 1).padStart(3, "0")}`,
        title: (us.title as string) || "",
        description: (us.description as string) || "",
        acceptanceCriteria: (us.acceptanceCriteria as string[]) || [],
        priority: (us.priority as number) || index + 1,
      })
    ),
    dependencies: Array.isArray(data.dependencies) ? data.dependencies : [],
  };
}

function parsePrdMarkdown(content: string): ParsedPrd {
  // Normalize line endings (CRLF -> LF)
  content = content.replace(/\r\n/g, "\n");

  const { data: frontmatter, content: body } = matter(content);

  // Extract title from first H1 or frontmatter
  const titleMatch = body.match(/^#\s+(.+)$/m);
  const title =
    (frontmatter.title as string) || titleMatch?.[1] || "Untitled PRD";

  // Extract branch name from frontmatter or generate from title
  const branchName =
    (frontmatter.branch as string) || generateBranchName(title);

  // Extract description
  const descMatch = body.match(
    /##\s*(?:Description|描述|Overview|概述)\s*\n([\s\S]*?)(?=\n##|\n$)/i
  );
  const description = descMatch?.[1]?.trim() || title;

  // Extract dependencies from frontmatter or body
  const dependencies = extractDependencies(frontmatter, body);

  // Extract user stories
  const userStories = extractUserStories(body);

  return {
    title,
    description,
    branchName,
    userStories,
    dependencies,
  };
}

/**
 * Extract dependencies from frontmatter or body.
 * Supports:
 * - Frontmatter: `dependencies: [ralph/prd-a, ralph/prd-b]`
 * - Body section: `## Dependencies\n- depends_on: prd-a.md`
 */
function extractDependencies(frontmatter: Record<string, unknown>, body: string): string[] {
  const deps: string[] = [];

  // From frontmatter (array of branch names)
  if (Array.isArray(frontmatter.dependencies)) {
    for (const dep of frontmatter.dependencies) {
      if (typeof dep === "string" && dep.trim()) {
        deps.push(normalizeDependency(dep.trim()));
      }
    }
  }

  // From body: ## Dependencies section
  const depsSection = body.match(
    /##\s*(?:Dependencies|依赖)\s*\n([\s\S]*?)(?=\n##[^#]|$)/i
  );
  if (depsSection) {
    // Match patterns like:
    // - depends_on: prd-shared-logic.md
    // - ralph/prd-shared-logic
    // - prd-shared-logic
    const depPattern = /[-*]\s*(?:depends_on:\s*)?(.+?)(?:\n|$)/gi;
    let match;
    while ((match = depPattern.exec(depsSection[1])) !== null) {
      const dep = match[1].trim();
      if (dep && !dep.startsWith("#")) {
        deps.push(normalizeDependency(dep));
      }
    }
  }

  return [...new Set(deps)]; // Deduplicate
}

/**
 * Normalize dependency to branch name format.
 * - "prd-shared-logic.md" -> "ralph/prd-shared-logic"
 * - "ralph/prd-shared-logic" -> "ralph/prd-shared-logic"
 * - "prd-shared-logic" -> "ralph/prd-shared-logic"
 */
function normalizeDependency(dep: string): string {
  // Remove .md extension if present
  dep = dep.replace(/\.md$/i, "");

  // If already has ralph/ prefix, return as-is
  if (dep.startsWith("ralph/")) {
    return dep;
  }

  // Add ralph/ prefix
  return `ralph/${dep}`;
}

function extractUserStories(content: string): ParsedUserStory[] {
  const stories: ParsedUserStory[] = [];

  // First, try to find the User Stories section
  const userStoriesSection = content.match(
    /##\s*(?:User Stories|用户故事)\s*\n([\s\S]*?)(?=\n##[^#]|$)/i
  );
  // Add leading newline to ensure pattern matches at start
  const searchContent = userStoriesSection?.[1]
    ? "\n" + userStoriesSection[1]
    : content;

  // Pattern 1: ### US-XXX: Title format (supports US-1, US-01, US-001)
  const usPattern =
    /\n###\s*(US-\d+)[:\s]+(.+?)\n([\s\S]*?)(?=\n###\s*US-|\n##[^#]|$)/gi;
  let match;

  while ((match = usPattern.exec(searchContent)) !== null) {
    const [, id, title, body] = match;
    const story = parseUserStoryBody(id.toUpperCase(), title, body);
    story.priority = stories.length + 1;
    stories.push(story);
  }

  // Pattern 2: Numbered list with checkboxes (only if no US-XXX found)
  if (stories.length === 0) {
    const listPattern = /^\d+\.\s*\[[ x]\]\s*\*\*(.+?)\*\*[:\s]*([\s\S]*?)(?=\n\d+\.\s*\[|\n##|$)/gim;
    let index = 0;

    while ((match = listPattern.exec(searchContent)) !== null) {
      const [, title, body] = match;
      index++;
      const id = `US-${String(index).padStart(3, "0")}`;
      const story = parseUserStoryBody(id, title.trim(), body);
      stories.push(story);
    }
  }

  // Pattern 3: Simple numbered list (only in User Stories section, not entire content)
  if (stories.length === 0 && userStoriesSection) {
    const simplePattern = /^\d+\.\s*(.+?)(?:\n|$)/gm;
    let index = 0;

    while ((match = simplePattern.exec(userStoriesSection[1])) !== null) {
      const [, title] = match;
      if (title.trim() && !title.startsWith("#")) {
        index++;
        stories.push({
          id: `US-${String(index).padStart(3, "0")}`,
          title: title.trim(),
          description: "",
          acceptanceCriteria: [],
          priority: index,
        });
      }
    }
  }

  return stories;
}

function parseUserStoryBody(
  id: string,
  title: string,
  body: string
): ParsedUserStory {
  // Extract description (As a... I want... So that...)
  const descMatch = body.match(/As\s+a[n]?\s+.+?(?:,\s*)?I\s+want.+?(?:,\s*)?So\s+that.+?(?:\.|$)/is);
  const description = descMatch?.[0]?.trim() || "";

  // Extract acceptance criteria
  const acMatch = body.match(
    /(?:Acceptance\s*Criteria|验收标准|AC)[:\s]*([\s\S]*?)(?=\n(?:Priority|优先级|Notes|备注)|$)/i
  );
  const acContent = acMatch?.[1] || body;

  const acceptanceCriteria: string[] = [];
  const acPattern = /[-*]\s*(.+?)(?:\n|$)/g;
  let acItem;
  while ((acItem = acPattern.exec(acContent)) !== null) {
    const criterion = acItem[1].trim();
    if (criterion && !criterion.startsWith("As a")) {
      acceptanceCriteria.push(criterion);
    }
  }

  // Extract priority
  const priorityMatch = body.match(/(?:Priority|优先级)[:\s]*(\d+)/i);
  const priority = priorityMatch ? parseInt(priorityMatch[1], 10) : 1;

  return {
    id,
    title: title.trim(),
    description,
    acceptanceCriteria,
    priority,
  };
}

/**
 * Generate branch name from PRD title
 */
export function generateBranchName(title: string): string {
  return `ralph/${title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50)}`;
}

/**
 * Analyze user story size and detect potentially oversized stories.
 * Heuristic rules:
 * - AC count > 5 → potentially too large
 * - Description length > 500 characters → potentially too large
 */
export function analyzeStorySize(stories: ParsedUserStory[]): StorySizeAnalysis {
  const warnings: StorySizeWarning[] = [];

  for (const story of stories) {
    const issues: string[] = [];
    const acCount = story.acceptanceCriteria.length;
    const descriptionLength = story.description.length;

    // Check AC count threshold
    if (acCount > 5) {
      issues.push(`${acCount} acceptance criteria (threshold: 5)`);
    }

    // Check description length threshold
    if (descriptionLength > 500) {
      issues.push(`${descriptionLength} character description (threshold: 500)`);
    }

    // If issues found, generate splitting suggestions
    if (issues.length > 0) {
      const suggestedSplits = generateSplitSuggestions(story);
      warnings.push({
        storyId: story.id,
        title: story.title,
        issues,
        acCount,
        descriptionLength,
        suggestedSplits,
      });
    }
  }

  return {
    hasOversizedStories: warnings.length > 0,
    warnings,
  };
}

/**
 * Generate splitting suggestions based on AC semantic grouping.
 * Analyzes AC text to identify common patterns (frontend, backend, API, UI, etc.)
 */
function generateSplitSuggestions(story: ParsedUserStory): string[] {
  const suggestions: string[] = [];
  const acs = story.acceptanceCriteria;

  if (acs.length === 0) {
    return suggestions;
  }

  // Semantic grouping keywords
  const frontendKeywords = ['ui', 'frontend', 'display', 'show', 'render', 'button', 'form', 'page', 'component', 'view', '界面', '显示', '按钮', '表单', '页面'];
  const backendKeywords = ['api', 'backend', 'server', 'database', 'db', 'endpoint', 'service', 'logic', '后端', '数据库', '接口', '服务'];
  const testKeywords = ['test', 'testing', 'validation', 'verify', 'check', '测试', '验证', '检查'];
  const dataKeywords = ['data', 'model', 'schema', 'migration', 'table', 'field', '数据', '模型', '字段', '迁移'];

  // Count ACs by category
  let frontendCount = 0;
  let backendCount = 0;
  let testCount = 0;
  let dataCount = 0;

  for (const ac of acs) {
    const lowerAc = ac.toLowerCase();
    if (frontendKeywords.some(kw => lowerAc.includes(kw))) frontendCount++;
    if (backendKeywords.some(kw => lowerAc.includes(kw))) backendCount++;
    if (testKeywords.some(kw => lowerAc.includes(kw))) testCount++;
    if (dataKeywords.some(kw => lowerAc.includes(kw))) dataCount++;
  }

  // Generate suggestions based on groupings
  if (frontendCount > 0 && backendCount > 0) {
    suggestions.push(`Split into "${story.title} - Frontend" (${frontendCount} AC) and "${story.title} - Backend" (${backendCount} AC)`);
  }

  if (dataCount > 0 && (frontendCount > 0 || backendCount > 0)) {
    suggestions.push(`Split into "${story.title} - Data Layer" (${dataCount} AC) and "${story.title} - Application Layer" (${frontendCount + backendCount} AC)`);
  }

  if (testCount > 0 && testCount < acs.length) {
    suggestions.push(`Split into "${story.title} - Implementation" (${acs.length - testCount} AC) and "${story.title} - Testing" (${testCount} AC)`);
  }

  // If no semantic grouping found, suggest splitting by priority/sequence
  if (suggestions.length === 0 && acs.length > 5) {
    const midpoint = Math.ceil(acs.length / 2);
    suggestions.push(`Split into "${story.title} - Part 1" (first ${midpoint} AC) and "${story.title} - Part 2" (remaining ${acs.length - midpoint} AC)`);
  }

  return suggestions;
}
