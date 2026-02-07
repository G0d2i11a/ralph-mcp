import { readFileSync } from "fs";
import matter from "gray-matter";
import { RalphConfig, DEFAULT_CONFIG } from "../config/schema.js";

export interface ParsedUserStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: number;
}

export interface ParsedPrd {
  title: string;
  description: string;
  branchName: string;
  userStories: ParsedUserStory[];
  dependencies: string[]; // Branch names this PRD depends on
  frontmatter: Record<string, unknown>; // Raw frontmatter for config overrides
}

/**
 * Parse a PRD markdown file into structured data.
 * Supports both markdown format and JSON format.
 */
export function parsePrdFile(filePath: string, config?: RalphConfig): ParsedPrd {
  const content = readFileSync(filePath, "utf-8");

  // Check if it's JSON format
  if (filePath.endsWith(".json")) {
    return parsePrdJson(content, config);
  }

  return parsePrdMarkdown(content, config);
}

function parsePrdJson(content: string, config?: RalphConfig): ParsedPrd {
  const data = JSON.parse(content);
  const branchPrefix = config?.merge?.branchPrefix || DEFAULT_CONFIG.merge.branchPrefix;

  return {
    title: data.description || data.title || "Untitled PRD",
    description: data.description || "",
    branchName: data.branchName || `${branchPrefix}unnamed`,
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
    frontmatter: data,
  };
}

function parsePrdMarkdown(content: string, config?: RalphConfig): ParsedPrd {
  const branchPrefix = config?.merge?.branchPrefix || DEFAULT_CONFIG.merge.branchPrefix;

  // Normalize line endings (CRLF -> LF)
  content = content.replace(/\r\n/g, "\n");

  const { data: frontmatter, content: body } = matter(content);

  // Extract title from first H1 or frontmatter
  const titleMatch = body.match(/^#\s+(.+)$/m);
  const title =
    (frontmatter.title as string) || titleMatch?.[1] || "Untitled PRD";

  // Extract branch name from frontmatter or generate from title
  const branchName =
    (frontmatter.branch as string) || generateBranchName(title, branchPrefix);

  // Extract description
  const descMatch = body.match(
    /##\s*(?:Description|描述|Overview|概述)\s*\n([\s\S]*?)(?=\n##|\n$)/i
  );
  const description = descMatch?.[1]?.trim() || title;

  // Extract dependencies from frontmatter or body
  const dependencies = extractDependencies(frontmatter, body, branchPrefix);

  // Extract user stories
  const userStories = extractUserStories(body);

  return {
    title,
    description,
    branchName,
    userStories,
    dependencies,
    frontmatter,
  };
}

/**
 * Extract dependencies from frontmatter or body.
 * Supports:
 * - Frontmatter: `dependencies: [ralph/prd-a, ralph/prd-b]`
 * - Body section: `## Dependencies\n- depends_on: prd-a.md`
 */
function extractDependencies(
  frontmatter: Record<string, unknown>,
  body: string,
  branchPrefix: string = "ralph/"
): string[] {
  const deps: string[] = [];

  // From frontmatter (array of branch names)
  if (Array.isArray(frontmatter.dependencies)) {
    for (const dep of frontmatter.dependencies) {
      if (typeof dep === "string" && dep.trim()) {
        deps.push(normalizeDependency(dep.trim(), branchPrefix));
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
        deps.push(normalizeDependency(dep, branchPrefix));
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
function normalizeDependency(dep: string, branchPrefix: string = "ralph/"): string {
  // Remove .md extension if present
  dep = dep.replace(/\.md$/i, "");

  // If already has the branch prefix, return as-is
  if (dep.startsWith(branchPrefix)) {
    return dep;
  }

  // Add branch prefix
  return `${branchPrefix}${dep}`;
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
export function generateBranchName(title: string, branchPrefix: string = "ralph/"): string {
  return `${branchPrefix}${title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50)}`;
}
