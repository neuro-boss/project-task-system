const DEFAULT_OFFSET_MINUTES = 0;

export const DEFAULT_ESTIMATE_HOURS = {
  XS: 2,
  S: 3,
  M: 6,
  L: 18,
  XL: 30,
};

const metadataNames = [
  "Created",
  "Updated",
  "Estimate",
  "Forecast Start",
  "Forecast Finish",
  "Due",
  "Started",
  "Completed",
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function metadataValue(body, name) {
  const match = new RegExp(
    `^\\*\\*${escapeRegExp(name)}:\\*\\*\\s*(.+?)\\s*$`,
    "mi",
  ).exec(body);
  return match?.[1]?.trim() || null;
}

export function parseTaskFile(markdown, state, idPrefix = "TASK") {
  const tasks = [];
  const pattern = new RegExp(`^## (${escapeRegExp(idPrefix)}-\\d+):\\s*(.+?)\\r?\\n([\\s\\S]*?)(?=^---\\s*$)`, "gm");
  for (const match of markdown.matchAll(pattern)) {
    const [, id, title, body] = match;
    const priority = /\*\*Priority:\*\*\s*(P[0-4])/.exec(body)?.[1] || "P2";
    const tagsText = /\*\*Tags:\*\*\s*([^\r\n]+)/.exec(body)?.[1] || "";
    const metadata = Object.fromEntries(
      metadataNames.map((name) => [name, metadataValue(body, name)]),
    );
    tasks.push({
      id,
      title: title.trim(),
      state,
      priority,
      tags: tagsText
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      metadata,
      body: body.trim(),
      order: tasks.length,
    });
  }
  return tasks;
}

export function parseEstimateHours(value, config = {}) {
  const hoursPerDay = config.workday?.hours ?? 6;
  const estimates = {
    ...DEFAULT_ESTIMATE_HOURS,
    ...(config.estimateHours || {}),
  };
  const normalised = String(value || config.defaultEstimate || "M")
    .trim()
    .toUpperCase();
  if (Object.hasOwn(estimates, normalised))
    return Number(estimates[normalised]);
  const match = /^(\d+(?:[.,]\d+)?)\s*([HD])$/.exec(normalised);
  if (!match) throw new Error(`Unsupported estimate: ${value}`);
  const amount = Number(match[1].replace(",", "."));
  return match[2] === "D" ? amount * hoursPerDay : amount;
}

function localParts(date, offsetMinutes) {
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function fromLocalParts(parts, offsetMinutes) {
  return new Date(
    Date.UTC(
      parts.year,
      parts.month,
      parts.day,
      parts.hour || 0,
      parts.minute || 0,
    ) -
      offsetMinutes * 60_000,
  );
}

function addLocalDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
  };
}

export function parseTaskDate(value, options = {}) {
  if (!value) return null;
  const text = String(value).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(text);
  if (!match) throw new Error(`Unsupported task date: ${value}`);
  const [, year, month, day, hour, minute] = match;
  const workday = options.workday || {};
  const endOfDay = options.endOfDay === true;
  return fromLocalParts(
    {
      year: Number(year),
      month: Number(month) - 1,
      day: Number(day),
      hour: hour
        ? Number(hour)
        : endOfDay
          ? (workday.startHour ?? 10) + (workday.hours ?? 6)
          : (workday.startHour ?? 10),
      minute: minute ? Number(minute) : 0,
    },
    workday.timezoneOffsetMinutes ?? DEFAULT_OFFSET_MINUTES,
  );
}

export function normaliseToWorkingTime(input, config = {}) {
  const workday = config.workday || {};
  const offset = workday.timezoneOffsetMinutes ?? DEFAULT_OFFSET_MINUTES;
  const startHour = workday.startHour ?? 10;
  const hours = workday.hours ?? 6;
  let parts = localParts(input, offset);
  while (parts.weekday === 0 || parts.weekday === 6) {
    parts = { ...addLocalDays(parts, 1), hour: startHour, minute: 0 };
  }
  const minuteOfDay = parts.hour * 60 + parts.minute;
  const startMinute = startHour * 60;
  const endMinute = (startHour + hours) * 60;
  if (minuteOfDay < startMinute) {
    return fromLocalParts({ ...parts, hour: startHour, minute: 0 }, offset);
  }
  if (minuteOfDay >= endMinute) {
    parts = { ...addLocalDays(parts, 1), hour: startHour, minute: 0 };
    return normaliseToWorkingTime(fromLocalParts(parts, offset), config);
  }
  return fromLocalParts(parts, offset);
}

export function addWorkingHours(input, amount, config = {}) {
  const workday = config.workday || {};
  const offset = workday.timezoneOffsetMinutes ?? DEFAULT_OFFSET_MINUTES;
  const startHour = workday.startHour ?? 10;
  const hoursPerDay = workday.hours ?? 6;
  let current = normaliseToWorkingTime(input, config);
  let remaining = Number(amount);
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new Error(`Estimate must be positive: ${amount}`);
  }
  while (remaining > 0) {
    const parts = localParts(current, offset);
    const end = fromLocalParts(
      { ...parts, hour: startHour + hoursPerDay, minute: 0 },
      offset,
    );
    const available = (end.getTime() - current.getTime()) / 3_600_000;
    if (remaining <= available) {
      return new Date(current.getTime() + remaining * 3_600_000);
    }
    remaining -= available;
    const next = { ...addLocalDays(parts, 1), hour: startHour, minute: 0 };
    current = normaliseToWorkingTime(fromLocalParts(next, offset), config);
  }
  return current;
}

function explicitForecast(task, config) {
  const start = parseTaskDate(task.metadata["Forecast Start"], config);
  const finish = parseTaskDate(task.metadata["Forecast Finish"], {
    ...config,
    endOfDay: true,
  });
  return start && finish ? { start, finish } : null;
}

export function buildForecast(tasks, now = new Date(), config = {}) {
  const result = new Map();
  const warnings = [];
  const scheduledStates = new Set(["Next", "In Progress"]);
  let nextCursor = normaliseToWorkingTime(now, config);

  for (const task of tasks.filter((item) => scheduledStates.has(item.state))) {
    const explicit = explicitForecast(task, config);
    const estimateMissing = !task.metadata.Estimate;
    let start;
    let finish;
    if (explicit) {
      ({ start, finish } = explicit);
    } else {
      if (task.state === "In Progress") {
        start = parseTaskDate(task.metadata.Started, config) || nextCursor;
        if (!task.metadata.Started)
          warnings.push(`${task.id}: missing Started; using current time`);
      } else {
        start = nextCursor;
      }
      if (estimateMissing)
        warnings.push(`${task.id}: missing Estimate; using default`);
      finish = addWorkingHours(
        start,
        parseEstimateHours(task.metadata.Estimate, config),
        config,
      );
    }
    const due = parseTaskDate(task.metadata.Due, {
      ...config,
      endOfDay: true,
    });
    result.set(task.id, {
      start,
      finish,
      deadline: due || finish,
      hardDeadline: due,
    });
    if (task.state === "Next")
      nextCursor = normaliseToWorkingTime(finish, config);
  }
  return { forecasts: result, warnings };
}

export function buildYouGilePayload(task, forecast, config, creating = false) {
  const columnId = config.columns?.[task.state];
  if (!columnId)
    throw new Error(`Missing YouGile column for state: ${task.state}`);
  const payload = {
    title: `${task.id}: ${task.title}`,
    columnId,
    description: task.body,
    completed: task.state === "Done",
    archived: false,
  };
  const color = config.priorityColors?.[task.priority];
  if (color) payload.color = color;
  const actualCompleted = parseTaskDate(task.metadata?.Completed, {
    ...config,
    endOfDay: true,
  });
  const recoveredCompletionDayStart =
    task.state === "Done"
      ? parseTaskDate(task.metadata?.Completed, config)
      : null;
  const recordedStart = parseTaskDate(
    task.metadata?.Started || task.metadata?.Created,
    config,
  );
  const actualStart =
    recordedStart &&
    actualCompleted &&
    recordedStart.getTime() <= actualCompleted.getTime()
      ? recordedStart
      : recoveredCompletionDayStart;
  const completedWindow =
    task.state === "Done" &&
    actualStart &&
    actualCompleted &&
    actualCompleted.getTime() >= actualStart.getTime()
      ? { start: actualStart, deadline: actualCompleted }
      : null;
  const ganttWindow = completedWindow || forecast;
  if (ganttWindow) {
    payload.deadline = {
      startDate: ganttWindow.start.getTime(),
      deadline: ganttWindow.deadline.getTime(),
      withTime: true,
      blockedPoints: [],
      links: [],
    };
  }
  if (creating) {
    payload.idempotencyKey = `${config.workspaceKey || "taskplanner"}:${task.id}`;
  }
  return payload;
}

export function selectSyncTasks(tasks, mapping, options = {}) {
  const activeStates = new Set(
    options.activeStates || ["Backlog", "Next", "In Progress"],
  );
  return tasks.filter(
    (task) =>
      activeStates.has(task.state) ||
      Boolean(mapping[task.id]) ||
      options.importHistory === true,
  );
}
