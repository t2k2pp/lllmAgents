import { describe, it, expect, beforeEach } from "vitest";
import {
  setTodos,
  getTodos,
  clearTodos,
  buildTodoSection,
  formatTodos,
  formatTodosActive,
  archiveCompletedTodos,
} from "../../src/tools/definitions/todo-write.js";
import {
  setGoal,
  getGoal,
  clearGoal,
  appendEvaluation,
  getEvaluationHistory,
  restoreGoalState,
  type GoalDefinition,
  type EvaluationRecord,
} from "../../src/agent/goal-slot.js";

const sampleGoal: GoalDefinition = {
  statement: "test goal",
  acceptance_criteria: ["a", "b"],
  created_at: 1_000,
  register_at_creation: "T2",
};

const sampleEval: EvaluationRecord = {
  iteration: 1,
  overall_score: 0.5,
  per_criterion: [0.5, 0.5],
  unmet: ["a"],
  gap_hint: "do a",
  passed: false,
  recorded_at: 2_000,
};

describe("ToDo / Goal lifecycle (docs/todo-goal-lifecycle.md)", () => {
  beforeEach(() => {
    clearTodos();
    clearGoal();
  });

  describe("Phase A: cross-contamination 阻止 (clear)", () => {
    it("clearTodos で全件消える", () => {
      setTodos([
        { content: "t1", status: "pending" },
        { content: "t2", status: "completed" },
      ]);
      expect(getTodos()).toHaveLength(2);
      clearTodos();
      expect(getTodos()).toHaveLength(0);
    });

    it("clearGoal で goal と history が両方消える", () => {
      setGoal(sampleGoal);
      appendEvaluation(sampleEval);
      expect(getGoal()).not.toBeNull();
      expect(getEvaluationHistory()).toHaveLength(1);
      clearGoal();
      expect(getGoal()).toBeNull();
      expect(getEvaluationHistory()).toHaveLength(0);
    });
  });

  describe("Phase B: session resume (restoreGoalState)", () => {
    it("restoreGoalState は setGoal と違い history も復元する", () => {
      setGoal(sampleGoal);
      appendEvaluation(sampleEval);
      const savedGoal = getGoal()!;
      const savedHistory = getEvaluationHistory();
      clearGoal();
      restoreGoalState(savedGoal, savedHistory);
      expect(getGoal()).toEqual(savedGoal);
      expect(getEvaluationHistory()).toEqual(savedHistory);
    });

    it("setGoal は history を [] リセットする (復元用途に使えないことの保証)", () => {
      setGoal(sampleGoal);
      appendEvaluation(sampleEval);
      expect(getEvaluationHistory()).toHaveLength(1);
      setGoal(sampleGoal);
      expect(getEvaluationHistory()).toHaveLength(0);
    });
  });

  describe("Phase C: active / archive 表示分離", () => {
    beforeEach(() => {
      setTodos([
        { content: "active1", status: "pending" },
        { content: "active2", status: "in_progress" },
        { content: "done1", status: "completed" },
        { content: "done2", status: "completed" },
      ]);
    });

    it("formatTodos は completed 含む全件を返す", () => {
      const out = formatTodos();
      expect(out).toContain("active1");
      expect(out).toContain("done1");
      expect(out).toContain("done2");
    });

    it("formatTodosActive は completed 本体を出さず件数のみ示す", () => {
      const out = formatTodosActive();
      expect(out).toContain("active1");
      expect(out).toContain("active2");
      expect(out).not.toContain("done1");
      expect(out).not.toContain("done2");
      expect(out).toContain("completed: 2 件");
    });

    it("buildTodoSection (system prompt 注入) は active のみフル展開 + completed 件数表示", () => {
      const section = buildTodoSection();
      expect(section).toContain("active1");
      expect(section).toContain("active2");
      expect(section).not.toContain("done1");
      expect(section).not.toContain("done2");
      expect(section).toContain("completed: 2 件");
    });

    it("buildTodoSection は completed のみ (active 0 件) の時は空文字を返す", () => {
      setTodos([
        { content: "done", status: "completed" },
      ]);
      expect(buildTodoSection()).toBe("");
    });

    it("buildTodoSection は完全に空の時も空文字", () => {
      clearTodos();
      expect(buildTodoSection()).toBe("");
    });

    it("archiveCompletedTodos は completed のみ削除し件数を返す", () => {
      const removed = archiveCompletedTodos();
      expect(removed).toBe(2);
      const remaining = getTodos();
      expect(remaining).toHaveLength(2);
      expect(remaining.every((t) => t.status !== "completed")).toBe(true);
    });

    it("archiveCompletedTodos は active が 0 件の時もエラーにならない", () => {
      clearTodos();
      expect(archiveCompletedTodos()).toBe(0);
    });
  });

  describe("ToDo と Goal の独立性 (docs/todo-goal-lifecycle.md §2.1)", () => {
    it("clearTodos しても goal は残る", () => {
      setGoal(sampleGoal);
      setTodos([{ content: "t", status: "pending" }]);
      clearTodos();
      expect(getGoal()).not.toBeNull();
      expect(getTodos()).toHaveLength(0);
    });

    it("clearGoal しても todos は残る", () => {
      setGoal(sampleGoal);
      setTodos([{ content: "t", status: "pending" }]);
      clearGoal();
      expect(getTodos()).toHaveLength(1);
      expect(getGoal()).toBeNull();
    });
  });
});
