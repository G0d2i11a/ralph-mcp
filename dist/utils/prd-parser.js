import { readFileSync } from "fs";
import matter from "gray-matter";
/**
 * Parse a PRD markdown file into structured data.
 * Supports both markdown format and JSON format.
 */
export function parsePrdFile(filePath) {
    const content = readFileSync(filePath, "utf-8");
    // Check if it's JSON format
    if (filePath.endsWith(".json")) {
        return parsePrdJson(content);
    }
    return parsePrdMarkdown(content);
}
function parsePrdJson(content) {
    const data = JSON.parse(content);
    return {
        title: data.description || data.title || "Untitled PRD",
        description: data.description || "",
        branchName: data.branchName || "ralph/unnamed",
        userStories: (data.userStories || []).map((us, index) => ({
            id: us.id || `US-${String(index + 1).padStart(3, "0")}`,
            title: us.title || "",
            description: us.description || "",
            acceptanceCriteria: us.acceptanceCriteria || [],
            priority: us.priority || index + 1,
        })),
    };
}
function parsePrdMarkdown(content) {
    // Normalize line endings (CRLF -> LF)
    content = content.replace(/\r\n/g, "\n");
    const { data: frontmatter, content: body } = matter(content);
    // Extract title from first H1 or frontmatter
    const titleMatch = body.match(/^#\s+(.+)$/m);
    const title = frontmatter.title || titleMatch?.[1] || "Untitled PRD";
    // Extract branch name from frontmatter or generate from title
    const branchName = frontmatter.branch || generateBranchName(title);
    // Extract description
    const descMatch = body.match(/##\s*(?:Description|描述|Overview|概述)\s*\n([\s\S]*?)(?=\n##|\n$)/i);
    const description = descMatch?.[1]?.trim() || title;
    // Extract user stories
    const userStories = extractUserStories(body);
    return {
        title,
        description,
        branchName,
        userStories,
    };
}
function extractUserStories(content) {
    const stories = [];
    // First, try to find the User Stories section
    const userStoriesSection = content.match(/##\s*(?:User Stories|用户故事)\s*\n([\s\S]*?)(?=\n##[^#]|$)/i);
    // Add leading newline to ensure pattern matches at start
    const searchContent = userStoriesSection?.[1]
        ? "\n" + userStoriesSection[1]
        : content;
    // Pattern 1: ### US-XXX: Title format (supports US-1, US-01, US-001)
    const usPattern = /\n###\s*(US-\d+)[:\s]+(.+?)\n([\s\S]*?)(?=\n###\s*US-|\n##[^#]|$)/gi;
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
function parseUserStoryBody(id, title, body) {
    // Extract description (As a... I want... So that...)
    const descMatch = body.match(/As\s+a[n]?\s+.+?(?:,\s*)?I\s+want.+?(?:,\s*)?So\s+that.+?(?:\.|$)/is);
    const description = descMatch?.[0]?.trim() || "";
    // Extract acceptance criteria
    const acMatch = body.match(/(?:Acceptance\s*Criteria|验收标准|AC)[:\s]*([\s\S]*?)(?=\n(?:Priority|优先级|Notes|备注)|$)/i);
    const acContent = acMatch?.[1] || body;
    const acceptanceCriteria = [];
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
export function generateBranchName(title) {
    return `ralph/${title
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 50)}`;
}
