import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

const execFileAsync = promisify(execFile);
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function earlier(current, candidate) {
  if (!current) return candidate;
  return candidate.timestamp < current.timestamp ? candidate : current;
}

function formatLocal(isoDate, timeZone) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(isoDate));
}

async function git(workspaceRoot, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

function taskIds(markdown, idPrefix) {
  const heading = new RegExp(`^## (${escapeRegExp(idPrefix)}-\\d+):`, "gm");
  return [...markdown.matchAll(heading)].map((match) => match[1]);
}

export async function collectHistoricalDateHints(
  workspaceRoot,
  states,
  workLogFile = ".tasks/WORK_LOG.md",
  options = {},
) {
  const idPrefix = options.idPrefix || "TASK";
  const timeZone = options.timeZone || "UTC";
  const hints = new Map();
  const ensure = (id) => {
    if (!hints.has(id)) hints.set(id, {});
    return hints.get(id);
  };

  for (const state of states) {
    const relativePath = `.tasks/${state.fileName}`;
    const log = await git(workspaceRoot, [
      "log",
      "--reverse",
      "--format=%H%x09%cI",
      "--",
      relativePath,
    ]);
    for (const line of log.split(/\r?\n/).filter(Boolean)) {
      const [hash, isoDate] = line.split("\t");
      let markdown;
      try {
        markdown = await git(workspaceRoot, [
          "show",
          `${hash}:${relativePath}`,
        ]);
      } catch {
        continue;
      }
      const candidate = {
        value: formatLocal(isoDate, timeZone),
        timestamp: new Date(isoDate).getTime(),
        source: "Git",
      };
      for (const id of taskIds(markdown, idPrefix)) {
        const hint = ensure(id);
        hint.created = earlier(hint.created, candidate);
        if (state.name === "In Progress") {
          hint.started = earlier(hint.started, candidate);
        }
        if (state.name === "Done") {
          hint.completed = earlier(hint.completed, candidate);
        }
      }
    }
  }

  try {
    const workLog = await readFile(`${workspaceRoot}/${workLogFile}`, "utf8");
    const workLogHeading = new RegExp(`^## (${escapeRegExp(idPrefix)}-\\d+) — (\\d{4}-\\d{2}-\\d{2})$`, "gm");
    for (const match of workLog.matchAll(workLogHeading)) {
      const hint = ensure(match[1]);
      hint.completed = {
        value: match[2],
        timestamp: Date.parse(`${match[2]}T13:00:00Z`),
        source: "Work Log, day precision",
      };
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  return hints;
}

export function enrichTasksWithHistoricalDates(tasks, hints) {
  return tasks.map((task) => {
    const hint = hints.get(task.id);
    if (!hint) return task;
    const metadata = { ...task.metadata };
    const added = [];
    const add = (field, candidate) => {
      if (metadata[field] || !candidate) return;
      metadata[field] = candidate.value;
      added.push({ field, ...candidate });
    };
    add("Created", hint.created);
    add("Started", hint.started);
    add("Completed", hint.completed);
    if (!added.length) return task;

    const metadataLines = added.map(
      ({ field, value }) => `**${field}:** ${value}`,
    );
    const sourceSummary = [...new Set(added.map(({ source }) => source))].join(
      "; ",
    );
    return {
      ...task,
      metadata,
      body: `${metadataLines.join("\n")}\n${task.body}\n\n> Historical dates recovered from ${sourceSummary}; missing dates were not invented.`,
    };
  });
}
