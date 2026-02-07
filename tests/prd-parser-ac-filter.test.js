/**
 * Test AC parsing with markdown formatting edge cases
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { parsePrdFile } from "../dist/utils/prd-parser.js";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const testPrdContent = `---
priority: P0
---

# Test PRD: AC Parsing

## 概述

Test AC parsing with markdown formatting.

## 用户故事

### US-001: Test Story

**作为** 开发者
**我想要** 测试 AC 解析
**以便** 确保格式正确

**验收标准:**

- 创建文件 A
- 移动方法 B
- 类型检查通过

**验证命令:**

\`\`\`bash
pnpm tsc --noEmit
\`\`\`

### US-002: Test with asterisk markers

**验收标准:**
*
- 第一个 AC
- 第二个 AC
- 第三个 AC
*验证命令:**
- pnpm build

### US-003: Test with bold markers

**验收标准:**

- AC 1
- AC 2

**Notes:**
- This is a note, not an AC
`;

describe("PRD Parser - AC Filtering", () => {
  let testFile;

  beforeEach(() => {
    testFile = join(tmpdir(), `test-prd-ac-${Date.now()}.md`);
    writeFileSync(testFile, testPrdContent);
  });

  afterEach(() => {
    try {
      unlinkSync(testFile);
    } catch (e) {
      // ignore
    }
  });

  test("should parse AC correctly without markdown markers", () => {
    const parsed = parsePrdFile(testFile);

    assert.strictEqual(parsed.userStories.length, 3);

    // US-001: Should have 3 valid ACs (no verification commands)
    const us1 = parsed.userStories[0];
    assert.strictEqual(us1.id, "US-001");
    assert.strictEqual(us1.acceptanceCriteria.length, 3);
    assert.deepStrictEqual(us1.acceptanceCriteria, [
      "创建文件 A",
      "移动方法 B",
      "类型检查通过",
    ]);

    // US-002: Should filter out "*" and "*验证命令:**", but include "pnpm build"
    const us2 = parsed.userStories[1];
    assert.strictEqual(us2.id, "US-002");
    // Should have 3 ACs (第一个/第二个/第三个 AC), no "*" or "*验证命令:**" or "pnpm build"
    // because "pnpm build" is under **验证命令:** section which should be excluded
    assert.strictEqual(us2.acceptanceCriteria.length, 3);
    assert.ok(!us2.acceptanceCriteria.includes("*"));
    assert.ok(!us2.acceptanceCriteria.includes("*验证命令:**"));
    assert.ok(us2.acceptanceCriteria.includes("第一个 AC"));
    assert.ok(us2.acceptanceCriteria.includes("第二个 AC"));
    assert.ok(us2.acceptanceCriteria.includes("第三个 AC"));
    // "pnpm build" should NOT be included as it's under verification section
    assert.ok(!us2.acceptanceCriteria.includes("pnpm build"));

    // US-003: Should have 2 ACs, no "**Notes:**" section content
    const us3 = parsed.userStories[2];
    assert.strictEqual(us3.id, "US-003");
    assert.strictEqual(us3.acceptanceCriteria.length, 2);
    assert.ok(us3.acceptanceCriteria.includes("AC 1"));
    assert.ok(us3.acceptanceCriteria.includes("AC 2"));
    // The note content should NOT be included as it's under **Notes:** section
    assert.ok(!us3.acceptanceCriteria.includes("This is a note, not an AC"));
  });

  test("should not include section headers as ACs", () => {
    const parsed = parsePrdFile(testFile);

    const allACs = parsed.userStories.flatMap((us) => us.acceptanceCriteria);

    // Should not include markdown formatting markers
    assert.ok(!allACs.includes("*"));
    assert.ok(!allACs.includes("**"));

    // Should not include section headers
    const hasVerificationHeader = allACs.some((ac) =>
      ac.match(/^验证命令[:：]/i)
    );
    assert.strictEqual(hasVerificationHeader, false);

    const hasNotesHeader = allACs.some((ac) => ac.match(/^Notes?[:：]/i));
    assert.strictEqual(hasNotesHeader, false);
  });
});
