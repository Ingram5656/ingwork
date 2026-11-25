#!/usr/bin/env node
// ingwork 的 AI 接口：让 Claude 这类 AI 助手读写番茄钟的任务。
//
// 它是一个 MCP 服务器（Model Context Protocol，AI 助手调用外部工具的通用做法），
// 走标准输入输出，只用 Node.js 自带的模块，不用装任何依赖。
// 它直接改数据文件夹里的 tasks.json；ingwork 开着的话，一秒内就会显示出来。
// 数据文件夹默认是 %APPDATA%\com.ingram.ingwork\，在 ingwork 的设置里换过（比如换到 OneDrive）的话，
// 换到哪记在 %APPDATA%\com.ingram.ingwork\location.json 里，这里每次都去读它。
//
// 不放进 ingwork.exe 里，是因为 AI 助手会一直开着这个进程：
// 要是开的是 ingwork.exe，它被占着，打包和自动更新都会因为"文件被占用"失败。
//
// 改 tasks.json 的规则（锁、字段、排序）和 src-tauri/src/tasks.rs 一样，改一边要改另一边。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const VERSION = "0.6.2";

// ---------- 数据文件 ----------

/** 和 tauri.conf.json 里的 identifier 一致。发布以后不能改 */
const IDENTIFIER = "com.ingram.ingwork";

/**
 * 本机的文件夹：放 location.json 和锁。和 Tauri 的 app_data_dir 一样：
 * Windows 是 %APPDATA%\com.ingram.ingwork，Mac 是 ~/Library/Application Support/com.ingram.ingwork。
 * 测试时可以用 INGWORK_DATA_DIR 指到别的文件夹
 */
function localDir() {
  if (process.env.INGWORK_DATA_DIR) return process.env.INGWORK_DATA_DIR;
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", IDENTIFIER);
  }
  const roaming = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(roaming, IDENTIFIER);
}

/** 任务表所在的文件夹。规则和 src-tauri/src/location.rs 一样 */
function dataDir() {
  const local = localDir();
  try {
    const config = JSON.parse(fs.readFileSync(path.join(local, "location.json"), "utf8"));
    if (typeof config.dataDir === "string" && config.dataDir) return config.dataDir;
  } catch {
    // 没换过：用本机的
  }
  return local;
}

const taskFile = () => path.join(dataDir(), "tasks.json");
/** 锁放本机，不放进网盘：它只管这台电脑上的 ingwork 和这个接口 */
const lockFile = () => path.join(localDir(), "tasks.lock");

const MAX_NAME = 80;
const MAX_ESTIMATE = 20;
const MAX_TASKS = 200;
const STALE_LOCK_MS = 10_000;

/** 用户能看懂的错误：会原样交给 AI，让它转告用户 */
class UserError extends Error {}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** 拿到 tasks.lock 再改文件，免得和 ingwork 同时写。规则和 tasks.rs 里的 FileLock 一样 */
function withLock(work) {
  const LOCK = lockFile();
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  let fd = null;
  for (let i = 0; i < 80 && fd === null; i++) {
    try {
      fd = fs.openSync(LOCK, "wx");
    } catch {
      try {
        if (Date.now() - fs.statSync(LOCK).mtimeMs > STALE_LOCK_MS) {
          fs.rmSync(LOCK, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      sleep(25);
    }
  }
  if (fd === null) throw new UserError("任务文件正被 ingwork 占着，请稍后再试");
  try {
    fs.closeSync(fd);
    return work();
  } finally {
    fs.rmSync(LOCK, { force: true });
  }
}

function emptyStore() {
  return { tasks: [], current: null, currentAt: 0, removed: [], savedAt: 0 };
}

function readStore() {
  let text;
  try {
    text = fs.readFileSync(taskFile(), "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") return emptyStore();
    // 文件在但读不出来：多半是 OneDrive 还没把它下载下来
    throw new UserError("任务文件还没从网盘下载下来，没有改动。请稍后再试");
  }
  let store;
  try {
    store = JSON.parse(text);
  } catch {
    throw new UserError("任务文件读不懂，没有改动。打开一次 ingwork 会把它修好");
  }
  store.tasks = Array.isArray(store.tasks) ? store.tasks : [];
  store.current = store.current ?? null;
  store.currentAt = Number(store.currentAt) || 0;
  store.removed = Array.isArray(store.removed) ? store.removed : [];
  store.savedAt = Number(store.savedAt) || 0;
  delete store.nextId;
  normalize(store);
  return store;
}

function writeStore(store) {
  const FILE = taskFile();
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  store.savedAt = Math.max(Date.now(), store.savedAt + 1);
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  // 改名偶尔会碰上 ingwork 正在读这个文件，稍等再试
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, FILE);
      return;
    } catch (e) {
      if (i >= 20) throw new UserError("任务没存下来，请再试一次");
      sleep(25);
    }
  }
}

/** 读、改、存一气呵成，全程拿着锁 */
function change(apply) {
  return withLock(() => {
    const store = readStore();
    const result = apply(store);
    writeStore(store);
    return { store, result };
  });
}

// ---------- 和 tasks.rs 里 Store 一样的规则 ----------

function cleanName(name) {
  const text = [...String(name ?? "").trim()].slice(0, MAX_NAME).join("");
  if (!text) throw new UserError("任务名不能是空的");
  return text;
}

function cleanEstimate(estimate) {
  const n = Math.round(Number(estimate));
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_ESTIMATE, Math.max(1, n));
}

function find(store, id) {
  const task = store.tasks.find((t) => t.id === id);
  if (!task) throw new UserError(`没有 id 是 ${id} 的任务，先用 list_tasks 看一下现在的任务`);
  return task;
}

/** 当前任务必须是一个还没勾掉的任务，否则清空 */
function normalize(store) {
  if (store.current !== null && !store.tasks.some((t) => t.id === store.current && !t.finished)) {
    store.current = null;
  }
}

/** 已完成的任务排在最后，新任务插在它们前面 */
function firstFinished(store) {
  const i = store.tasks.findIndex((t) => t.finished);
  return i < 0 ? store.tasks.length : i;
}

// ---------- 几台电脑共用时合并要用的记号（和 tasks.rs 一样） ----------
// 每个任务记着最后修改的时刻（updatedAt），删掉的任务留一个删除记号（removed），
// ingwork 读到别的电脑改过的文件时，靠它们逐条合并。

let counter = 0;
const base36 = (n) => n.toString(36);

/** 新任务的 id：时刻 + 序号 + 随机数，几台电脑各自加任务也不会撞 */
function newId() {
  const count = counter++ % 1296;
  const salt = Math.floor(Math.random() * 1296);
  return `t${base36(Date.now())}${base36(count).padStart(2, "0")}${base36(salt).padStart(2, "0")}`;
}

function touch(task) {
  task.updatedAt = Date.now();
}

function setCurrentId(store, id) {
  store.current = id;
  store.currentAt = Date.now();
}

function addTask(store, name, estimate) {
  const clean = cleanName(name);
  if (store.tasks.length >= MAX_TASKS) throw new UserError("任务太多了，先在 ingwork 里清空一些已完成的");
  const task = { id: newId(), name: clean, estimate: cleanEstimate(estimate), spent: 0, finished: false };
  touch(task);
  store.tasks.splice(firstFinished(store), 0, task);
  if (store.current === null) setCurrentId(store, task.id);
  return task;
}

function setFinished(store, id, finished) {
  const task = find(store, id);
  if (task.finished === finished) return;
  task.finished = finished;
  touch(task);
  store.tasks = store.tasks.filter((t) => t !== task);
  store.tasks.splice(firstFinished(store), 0, task);
  if (finished && store.current === id) {
    setCurrentId(store, store.tasks.find((t) => !t.finished)?.id ?? null);
  }
}

function setCurrent(store, id) {
  if (id === null || id === undefined || id === "") {
    setCurrentId(store, null);
    return;
  }
  const task = find(store, id);
  if (task.finished) throw new UserError(`「${task.name}」已经完成了，先把它改回未完成`);
  setCurrentId(store, id);
}

// ---------- 给 AI 看的样子 ----------

function describe(store) {
  const open = store.tasks.filter((t) => !t.finished);
  const done = store.tasks.filter((t) => t.finished);
  const line = (t) =>
    `- [${t.id}] ${t.name} · 番茄 ${t.spent}/${t.estimate}` + (t.id === store.current ? " · 当前任务" : "");
  const parts = [];
  parts.push(open.length ? `未完成（${open.length}）：\n${open.map(line).join("\n")}` : "未完成：没有");
  if (done.length) parts.push(`已完成（${done.length}）：\n${done.map(line).join("\n")}`);
  const left = open.reduce((sum, t) => sum + Math.max(0, t.estimate - t.spent), 0);
  if (open.length) parts.push(`还要 ${left} 个番茄。`);
  return parts.join("\n\n");
}

// ---------- 工具 ----------

const TOOLS = [
  {
    name: "list_tasks",
    description:
      "List the user's tasks in the ingwork pomodoro timer: id, name, pomodoros done / estimated, " +
      "whether it is finished, and which one is the current task. Call this before editing so you have the ids.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: () => describe(withLock(readStore)),
  },
  {
    name: "add_tasks",
    description:
      "Add one or more tasks to the ingwork to-do list. Write task names in the user's language, short and concrete. " +
      "estimate is how many 25-minute pomodoros the task should take (1-20); if the user did not say, make a sensible guess. " +
      "New tasks go after the unfinished ones. If there was no current task, the first new one becomes current.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Task name, at most 80 characters" },
              estimate: { type: "integer", minimum: 1, maximum: MAX_ESTIMATE, description: "Estimated pomodoros" },
            },
            required: ["name"],
            additionalProperties: false,
          },
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
    run: ({ tasks }) => {
      if (!Array.isArray(tasks) || tasks.length === 0) throw new UserError("没有要添加的任务");
      const { store, result } = change((s) => tasks.map((t) => addTask(s, t.name, t.estimate ?? 1)));
      return `添加了 ${result.length} 个任务：${result.map((t) => `${t.name}（${t.estimate} 个番茄）`).join("、")}\n\n${describe(store)}`;
    },
  },
  {
    name: "update_task",
    description:
      "Change one task: rename it, change its estimated pomodoros, or mark it finished / not finished. " +
      "Only pass the fields you want to change. Finishing the current task makes the next unfinished task current.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task id from list_tasks" },
        name: { type: "string" },
        estimate: { type: "integer", minimum: 1, maximum: MAX_ESTIMATE },
        finished: { type: "boolean" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    run: ({ id, name, estimate, finished }) => {
      const { store } = change((s) => {
        const task = find(s, id);
        const before = `${task.name}\u0000${task.estimate}`;
        if (name !== undefined) task.name = cleanName(name);
        if (estimate !== undefined) task.estimate = cleanEstimate(estimate);
        if (`${task.name}\u0000${task.estimate}` !== before) touch(task);
        if (finished !== undefined) setFinished(s, id, Boolean(finished));
      });
      return `改好了。\n\n${describe(store)}`;
    },
  },
  {
    name: "set_current_task",
    description:
      "Choose which task the user is working on now. Each finished focus session adds one pomodoro to it. " +
      "Pass id null to have no current task.",
    inputSchema: {
      type: "object",
      properties: { id: { type: ["string", "null"], description: "Task id from list_tasks, or null" } },
      required: ["id"],
      additionalProperties: false,
    },
    run: ({ id }) => {
      const { store } = change((s) => setCurrent(s, id));
      return `${store.current ? "当前任务换好了。" : "现在没有当前任务。"}\n\n${describe(store)}`;
    },
  },
  {
    name: "delete_task",
    description:
      "Delete one task permanently, including the pomodoros recorded for it. Only do this when the user clearly asks; " +
      "to mark a task done use update_task with finished true instead.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Task id from list_tasks" } },
      required: ["id"],
      additionalProperties: false,
    },
    run: ({ id }) => {
      const { store, result } = change((s) => {
        const task = find(s, id);
        s.tasks = s.tasks.filter((t) => t.id !== id);
        s.removed = s.removed.filter((r) => r.id !== id);
        s.removed.push({ id, at: Date.now() });
        s.removed.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        normalize(s);
        return task;
      });
      return `删掉了「${result.name}」。\n\n${describe(store)}`;
    },
  },
];

// ---------- MCP（JSON-RPC 2.0，一行一条消息） ----------

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(message) {
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "ingwork", version: VERSION },
        instructions:
          "Tools for the user's ingwork pomodoro timer to-do list. When the user tells you what they plan to do, " +
          "add those as tasks with sensible pomodoro estimates. The ingwork app shows changes within a second.",
      });
    case "ping":
      return isRequest ? reply(id, {}) : undefined;
    case "tools/list":
      return reply(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return fail(id, -32602, `没有叫 ${params?.name} 的工具`);
      try {
        const text = tool.run(params?.arguments ?? {});
        return reply(id, { content: [{ type: "text", text }] });
      } catch (e) {
        const text = e instanceof UserError ? e.message : `出错了：${e?.message ?? e}`;
        return reply(id, { content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      // 通知（没有 id 的消息）不用回
      if (isRequest) fail(id, -32601, `不支持 ${method}`);
  }
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "看不懂这条消息" } });
  }
  for (const one of Array.isArray(message) ? message : [message]) handle(one);
});
input.on("close", () => process.exit(0));
