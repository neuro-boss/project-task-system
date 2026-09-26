import assert from "node:assert/strict";
import test from "node:test";
import {
  addWorkingHours,
  buildForecast,
  buildYouGilePayload,
  parseEstimateHours,
  parseTaskFile,
  selectSyncTasks,
} from "./taskplanner-yougile-core.mjs";
import { enrichTasksWithHistoricalDates } from "./taskplanner-yougile-history.mjs";
import { classifyTaskModule } from "./taskplanner-yougile-modules-core.mjs";

const config = {
  workspaceKey: "example-repository",
  columns: {
    Backlog: "column-backlog",
    Next: "column-next",
    "In Progress": "column-progress",
    Done: "column-done",
    Rejected: "column-rejected",
  },
  workday: { startHour: 10, hours: 6, timezoneOffsetMinutes: 180 },
  priorityColors: { P1: "task-red" },
};

test("parses TaskPlanner metadata without changing task content", () => {
  const [task] = parseTaskFile(
    `# Next\n\n## TASK-172: Connect YouGile\n\n**Priority:** P1 | **Tags:** api, planning\n**Created:** 2026-08-30 21:29\n**Estimate:** L\n\nDescription.\n\n---\n`,
    "Next",
  );
  assert.equal(task.id, "TASK-172");
  assert.equal(task.priority, "P1");
  assert.deepEqual(task.tags, ["api", "planning"]);
  assert.equal(task.metadata.Created, "2026-08-30 21:29");
  assert.equal(task.metadata.Estimate, "L");
});

test("parses a repository-specific TaskPlanner ID prefix", () => {
  const [task] = parseTaskFile("## DEV-007: Build UI\n\n**Priority:** P2\n\n---\n", "Next", "DEV");
  assert.equal(task.id, "DEV-007");
});

test("classifies modules from repository rules and reports ambiguity", () => {
  const moduleConfig = {
    modules: [
      { key: "frontend", name: "Frontend", tags: ["web"] },
      { key: "product", name: "Product", keywords: ["checkout"] },
      { key: "other", name: "Other" },
    ],
    moduleFallback: "other",
    moduleOverrides: { "DEV-2": "product" },
  };
  const first = classifyTaskModule({ id: "DEV-1", title: "Checkout UI", tags: ["web"] }, moduleConfig);
  assert.equal(first.module.key, "frontend");
  assert.equal(first.ambiguous, true);
  assert.equal(classifyTaskModule({ id: "DEV-2", title: "Other", tags: [] }, moduleConfig).module.key, "product");
  assert.equal(classifyTaskModule({ id: "DEV-3", title: "Other", tags: [] }, moduleConfig).module.key, "other");
});

test("supports size, hour and day estimates", () => {
  assert.equal(parseEstimateHours("XS", config), 2);
  assert.equal(parseEstimateHours("4h", config), 4);
  assert.equal(parseEstimateHours("2d", config), 12);
});

test("working time skips a weekend", () => {
  const friday = new Date("2026-08-28T13:00:00+03:00");
  assert.equal(
    addWorkingHours(friday, 6, config).toISOString(),
    "2026-08-31T10:00:00.000Z",
  );
});

test("forecasts Next sequentially and In Progress from actual start", () => {
  const tasks = [
    {
      id: "TASK-1",
      state: "In Progress",
      metadata: { Started: "2026-08-31 10:00", Estimate: "M", Due: null },
    },
    {
      id: "TASK-2",
      state: "Next",
      metadata: { Started: null, Estimate: "M", Due: null },
    },
    {
      id: "TASK-3",
      state: "Next",
      metadata: { Started: null, Estimate: "S", Due: null },
    },
  ];
  const { forecasts } = buildForecast(
    tasks,
    new Date("2026-08-31T10:00:00+03:00"),
    config,
  );
  assert.equal(
    forecasts.get("TASK-1").finish.toISOString(),
    "2026-08-31T13:00:00.000Z",
  );
  assert.equal(
    forecasts.get("TASK-2").start.toISOString(),
    "2026-08-31T07:00:00.000Z",
  );
  assert.equal(
    forecasts.get("TASK-3").start.toISOString(),
    "2026-09-01T07:00:00.000Z",
  );
});

test("builds an idempotent YouGile create payload", () => {
  const task = {
    id: "TASK-172",
    title: "Connect YouGile",
    state: "Next",
    priority: "P1",
    body: "Description",
  };
  const forecast = {
    start: new Date("2026-09-01T07:00:00.000Z"),
    deadline: new Date("2026-09-01T13:00:00.000Z"),
  };
  const payload = buildYouGilePayload(task, forecast, config, true);
  assert.equal(payload.columnId, "column-next");
  assert.equal(payload.idempotencyKey, "example-repository:TASK-172");
  assert.equal(payload.color, "task-red");
  assert.equal(payload.deadline.startDate, forecast.start.getTime());
});

test("uses actual start and completion dates for a completed Gantt item", () => {
  const task = {
    id: "TASK-172",
    title: "Connect YouGile",
    state: "Done",
    priority: "P1",
    body: "Description",
    metadata: {
      Created: "2026-08-30 21:29",
      Started: "2026-08-30 21:29",
      Completed: "2026-08-30 22:31",
    },
  };
  const payload = buildYouGilePayload(task, undefined, config, false);
  assert.equal(
    new Date(payload.deadline.startDate).toISOString(),
    "2026-08-30T18:29:00.000Z",
  );
  assert.equal(
    new Date(payload.deadline.deadline).toISOString(),
    "2026-08-30T19:31:00.000Z",
  );
  assert.equal(payload.completed, true);
});

test("uses the end of the workday for a recovered date-only completion", () => {
  const task = {
    id: "TASK-10",
    title: "Historical task",
    state: "Done",
    priority: "P1",
    body: "Description",
    metadata: {
      Created: "2026-08-28 11:00",
      Completed: "2026-08-30",
    },
  };
  const payload = buildYouGilePayload(task, undefined, config, false);
  assert.equal(
    new Date(payload.deadline.startDate).toISOString(),
    "2026-08-28T08:00:00.000Z",
  );
  assert.equal(
    new Date(payload.deadline.deadline).toISOString(),
    "2026-08-30T13:00:00.000Z",
  );
});

test("uses the completion day as a Gantt marker when historical start is unknown", () => {
  const task = {
    id: "TASK-11",
    title: "Historical task without start",
    state: "Done",
    priority: "P2",
    body: "Description",
    metadata: { Completed: "2026-08-30" },
  };
  const payload = buildYouGilePayload(task, undefined, config, false);
  assert.equal(
    new Date(payload.deadline.startDate).toISOString(),
    "2026-08-30T07:00:00.000Z",
  );
  assert.equal(
    new Date(payload.deadline.deadline).toISOString(),
    "2026-08-30T13:00:00.000Z",
  );
});

test("ignores a Git start recorded after the historical completion day", () => {
  const task = {
    id: "TASK-12",
    title: "Imported after completion",
    state: "Done",
    priority: "P2",
    body: "Description",
    metadata: {
      Created: "2026-08-31 12:00",
      Completed: "2026-08-30",
    },
  };
  const payload = buildYouGilePayload(task, undefined, config, false);
  assert.equal(
    new Date(payload.deadline.startDate).toISOString(),
    "2026-08-30T07:00:00.000Z",
  );
  assert.equal(
    new Date(payload.deadline.deadline).toISOString(),
    "2026-08-30T13:00:00.000Z",
  );
});

test("enriches missing historical dates without overwriting task metadata", () => {
  const [task] = enrichTasksWithHistoricalDates(
    [
      {
        id: "TASK-10",
        body: "**Priority:** P2\n\nDescription",
        metadata: { Created: null, Started: "2026-08-20 12:00", Completed: null },
      },
    ],
    new Map([
      [
        "TASK-10",
        {
          created: { value: "2026-08-19 10:00", source: "Git", timestamp: 1 },
          started: { value: "2026-08-20 10:00", source: "Git", timestamp: 2 },
          completed: {
            value: "2026-08-21",
            source: "Work Log, day precision",
            timestamp: 3,
          },
        },
      ],
    ]),
  );
  assert.equal(task.metadata.Created, "2026-08-19 10:00");
  assert.equal(task.metadata.Started, "2026-08-20 12:00");
  assert.equal(task.metadata.Completed, "2026-08-21");
  assert.match(task.body, /Historical dates recovered/);
});

test("does not import old completed tasks unless mapped or requested", () => {
  const tasks = [
    { id: "TASK-1", state: "Backlog" },
    { id: "TASK-2", state: "Done" },
    { id: "TASK-3", state: "Done" },
  ];
  assert.deepEqual(
    selectSyncTasks(tasks, { "TASK-3": "yougile-3" }).map((task) => task.id),
    ["TASK-1", "TASK-3"],
  );
});
