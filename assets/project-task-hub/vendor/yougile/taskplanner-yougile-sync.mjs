import { readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  buildForecast,
  buildYouGilePayload,
  parseTaskFile,
  selectSyncTasks,
} from "./taskplanner-yougile-core.mjs";
import {
  collectHistoricalDateHints,
  enrichTasksWithHistoricalDates,
} from "./taskplanner-yougile-history.mjs";
import { classifyTaskModule } from "./taskplanner-yougile-modules-core.mjs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const doctor = args.includes("--doctor");
const discover = args.includes("--discover");
const importHistory = args.includes("--import-history");
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const onlyTask = option("--task");
const workspaceRoot = resolve(option("--workspace") || process.cwd());
const requestedConfig = option("--config");
const localConfigPath = resolve(
  workspaceRoot,
  requestedConfig || ".tasks/yougile.local.json",
);
const exampleConfigPath = resolve(workspaceRoot, ".tasks/yougile.example.json");
const mappingPath = resolve(workspaceRoot, ".tasks/yougile.local-state.json");
const hashesPath = resolve(workspaceRoot, ".tasks/yougile.local-hashes.json");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function loadConfig() {
  try {
    return { config: await readJson(localConfigPath), path: localConfigPath };
  } catch (error) {
    if (error.code !== "ENOENT" || apply || doctor || requestedConfig)
      throw error;
    return {
      config: await readJson(exampleConfigPath),
      path: exampleConfigPath,
    };
  }
}

async function loadOptionalJson(path) {
  try {
    return await readJson(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return {};
  }
}

async function saveJson(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function validateConfig(config, strict) {
  const requiredStates = ["Backlog", "Next", "In Progress", "Done", "Rejected"];
  for (const state of requiredStates) {
    if (!config.columns?.[state]) throw new Error(`Missing columns.${state}`);
  }
  if (!config.baseUrl) throw new Error("Missing baseUrl");
  if (!config.workspaceKey) throw new Error("Missing workspaceKey");
  if (new Set(Object.values(config.columns)).size !== requiredStates.length)
    throw new Error("Each TaskPlanner state needs a distinct YouGile column");
  if (config.modules?.length && !config.moduleStickerName)
    throw new Error("Set moduleStickerName when modules are configured");
  if (strict) {
    if (!config.baseUrl.startsWith("https://"))
      throw new Error("YouGile baseUrl must use HTTPS");
    if (String(config.workspaceKey).startsWith("replace-"))
      throw new Error("Configure a unique workspaceKey before connecting to YouGile");
    for (const field of ["projectId", "boardId"]) {
      if (!config[field] || String(config[field]).startsWith("replace-")) {
        throw new Error(`Configure ${field} before connecting to YouGile`);
      }
    }
    for (const [state, id] of Object.entries(config.columns)) {
      if (String(id).startsWith("replace-")) {
        throw new Error(
          `Configure columns.${state} before connecting to YouGile`,
        );
      }
    }
  }
}

async function apiKey() {
  const value = process.env.YOUGILE_API_KEY?.trim();
  if (value) return value;
  const keyPath = resolve(
    workspaceRoot,
    config.apiKeyFile || ".tasks/yougile.api-key.txt",
  );
  try {
    const fileValue = (await readFile(keyPath, "utf8")).trim();
    if (fileValue) return fileValue;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  throw new Error(
    "YouGile key is required; set YOUGILE_API_KEY or apiKeyFile outside Git. Never paste the key into chat or config",
  );
}

let lastRequestAt = 0;
async function apiRequest(config, key, method, path, body) {
  const interval = config.minRequestIntervalMs ?? 1250;
  const wait = Math.max(0, lastRequestAt + interval - Date.now());
  if (wait) await new Promise((resolveWait) => setTimeout(resolveWait, wait));
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${key}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(config.timeoutMs ?? 15_000),
  });
  lastRequestAt = Date.now();
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(
      `YouGile ${method} ${path} failed with HTTP ${response.status}`,
    );
  }
  return data;
}

async function loadModuleSticker(config, key) {
  if (!config.moduleStickerName) return null;
  const result = await apiRequest(
    config,
    key,
    "GET",
    `/string-stickers?boardId=${encodeURIComponent(config.boardId)}&name=${encodeURIComponent(config.moduleStickerName)}&limit=100`,
  );
  const matching = (result?.content || []).filter(
    (sticker) =>
      sticker.name === config.moduleStickerName && sticker.deleted !== true,
  );
  if (matching.length !== 1) {
    throw new Error(
      `Expected one active ${config.moduleStickerName} sticker on the board; create it in YouGile before syncing modules`,
    );
  }
  return matching[0];
}

const { config, path: configPath } = await loadConfig();
validateConfig(config, apply || doctor);

if (discover) {
  const key = await apiKey();
  const projects = await apiRequest(config, key, "GET", "/projects?limit=100");
  const boards = await apiRequest(config, key, "GET", "/boards?limit=100");
  const columns = await apiRequest(config, key, "GET", "/columns?limit=100");
  console.log(
    JSON.stringify(
      {
        mode: "discover",
        projects: (projects?.content || []).map(({ id, title }) => ({
          id,
          title,
        })),
        boards: (boards?.content || []).map(({ id, title, projectId }) => ({
          id,
          title,
          projectId,
        })),
        columns: (columns?.content || []).map(({ id, title, boardId }) => ({
          id,
          title,
          boardId,
        })),
      },
      null,
      2,
    ),
  );
} else if (doctor) {
  const key = await apiKey();
  const me = await apiRequest(config, key, "GET", "/users/me");
  const board = await apiRequest(
    config,
    key,
    "GET",
    `/boards/${config.boardId}`,
  );
  const columns = await apiRequest(
    config,
    key,
    "GET",
    `/columns?boardId=${encodeURIComponent(config.boardId)}&limit=100`,
  );
  const availableColumns = new Set(
    (columns?.content || []).map((item) => item.id),
  );
  const missingColumns = Object.entries(config.columns)
    .filter(([, id]) => !availableColumns.has(id))
    .map(([state]) => state);
  console.log(
    JSON.stringify({
      mode: "doctor",
      authenticatedUserId: me.id,
      boardId: board.id,
      projectMatches: board.projectId === config.projectId,
      configuredColumns: Object.keys(config.columns).length,
      missingColumns,
    }),
  );
  if (missingColumns.length || board.projectId !== config.projectId) process.exitCode = 1;
} else {
  const boardConfig = await readJson(
    resolve(workspaceRoot, ".tasks/config.json"),
  );
  let tasks = [];
  for (const state of boardConfig.states) {
    const markdown = await readFile(
      resolve(workspaceRoot, ".tasks", state.fileName),
      "utf8",
    );
    tasks.push(...parseTaskFile(markdown, state.name, boardConfig.idPrefix || "TASK"));
  }
  if (importHistory) {
    const historyHints = await collectHistoricalDateHints(
      workspaceRoot,
      boardConfig.states,
      ".tasks/WORK_LOG.md",
      { idPrefix: boardConfig.idPrefix || "TASK", timeZone: config.historyTimeZone || "UTC" },
    );
    tasks = enrichTasksWithHistoricalDates(tasks, historyHints);
  }
  const mapping = await loadOptionalJson(mappingPath);
  const hashes = await loadOptionalJson(hashesPath);
  const offset = config.workday?.timezoneOffsetMinutes ?? 0;
  const dayStart = Math.floor((Date.now() + offset * 60_000) / 86_400_000) * 86_400_000 - offset * 60_000;
  const { forecasts, warnings: allWarnings } = buildForecast(
    tasks,
    new Date(dayStart),
    config,
  );
  const selected = onlyTask
    ? tasks.filter((task) => task.id === onlyTask)
    : selectSyncTasks(tasks, mapping, {
        activeStates: config.activeStates,
        importHistory,
      });
  if (onlyTask && !selected.length)
    throw new Error(`Task not found: ${onlyTask}`);
  const warnings = onlyTask
    ? allWarnings.filter((warning) => warning.startsWith(`${onlyTask}:`))
    : allWarnings;

  const operations = selected.map((task) => {
    const creating = !mapping[task.id];
    const classification = config.modules?.length ? classifyTaskModule(task, config) : null;
    const moduleName = classification?.module?.name || null;
    if (classification?.ambiguous)
      warnings.push(`${task.id}: ambiguous modules ${classification.matches.map((item) => item.name).join(", ")}`);
    const payload = buildYouGilePayload(
      task,
      forecasts.get(task.id),
      config,
      creating,
    );
    const hash = createHash("sha256").update(JSON.stringify({ payload, moduleName })).digest("hex");
    return {
      taskId: task.id,
      state: task.state,
      ...(moduleName ? { module: moduleName } : {}),
      method: creating ? "POST" : "PUT",
      path: creating ? "/tasks" : `/tasks/${mapping[task.id]}`,
      payload,
      hash,
      unchanged: !creating && hashes[task.id] === hash,
    };
  });

  if (!apply) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          configPath,
          operations: operations.map(({ taskId, state, module, method, unchanged, payload }) => ({
            taskId,
            state,
            ...(module ? { module } : {}),
            method,
            unchanged,
            columnId: payload.columnId,
            gantt: Boolean(payload.deadline),
          })),
          warnings,
          note: "No external requests were made",
        },
        null,
        2,
      ),
    );
  } else {
    const key = await apiKey();
    const moduleSticker = await loadModuleSticker(config, key);
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    for (const operation of operations) {
      if (operation.unchanged) {
        unchanged += 1;
        continue;
      }
      let payload = operation.payload;
      if (moduleSticker) {
        const state = (moduleSticker.states || []).find(
          (item) => item.name === operation.module && item.deleted !== true,
        );
        if (!state) {
          throw new Error(
            `Missing ${config.moduleStickerName} state: ${operation.module}`,
          );
        }
        payload = {
          ...payload,
          stickers: {
            ...(payload.stickers || {}),
            [moduleSticker.id]: state.id,
          },
        };
      }
      const response = await apiRequest(
        config,
        key,
        operation.method,
        operation.path,
        payload,
      );
      if (operation.method === "POST") {
        if (!response?.id)
          throw new Error(`YouGile did not return id for ${operation.taskId}`);
        mapping[operation.taskId] = response.id;
        await saveJson(mappingPath, mapping);
        created += 1;
      } else updated += 1;
      hashes[operation.taskId] = operation.hash;
      await saveJson(hashesPath, hashes);
    }
    console.log(
      JSON.stringify({
        mode: "apply",
        created,
        updated,
        unchanged,
        warnings,
        mappingPath,
      }),
    );
  }
}
