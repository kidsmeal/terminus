import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exists, readTextFile, writeTextFile, mkdir, BaseDirectory } from "@tauri-apps/plugin-fs";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

// --- Audio engine ---
const audioCtx = new AudioContext();

function synth(type: OscillatorType, freq: number, vol: number, dur: number) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.value = vol;
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
  osc.start();
  osc.stop(audioCtx.currentTime + dur);
}

function playKeySound() {
  synth("square", 800 + Math.random() * 400, 0.03, 0.05);
}

function playCommandSound() {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.type = "square";
  const now = audioCtx.currentTime;
  osc.frequency.setValueAtTime(440, now);
  osc.frequency.setValueAtTime(660, now + 0.06);
  osc.frequency.setValueAtTime(880, now + 0.12);
  gain.gain.value = 0.06;
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
  osc.start();
  osc.stop(now + 0.2);
}

function playChime(notes: number[], type: OscillatorType, vol: number, spacing: number, dur: number) {
  notes.forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = type;
    const t = audioCtx.currentTime + i * spacing;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.start(t);
    osc.stop(t + dur);
  });
}

function playLevelUpSound() { playChime([523, 659, 784, 1047], "square", 0.08, 0.1, 0.15); }
function playAchievementSound() { playChime([784, 988, 1175, 1319, 1568], "triangle", 0.07, 0.08, 0.2); }
function playTabSound() { synth("square", 1200, 0.04, 0.06); }
function playFolderSound() { synth("triangle", 600, 0.05, 0.08); }

// --- Particle system ---
class Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; maxLife: number; color: string; size: number;
  constructor(x: number, y: number, color: string) {
    this.x = x; this.y = y;
    this.vx = (Math.random() - 0.5) * 6;
    this.vy = (Math.random() - 0.5) * 6 - 2;
    this.maxLife = 30 + Math.random() * 30;
    this.life = this.maxLife;
    this.color = color;
    this.size = 2 + Math.random() * 3;
  }
  update() { this.x += this.vx; this.y += this.vy; this.vy += 0.1; this.life--; }
  draw(ctx: CanvasRenderingContext2D) {
    const a = this.life / this.maxLife;
    ctx.fillStyle = this.color + Math.floor(a * 255).toString(16).padStart(2, '0');
    ctx.fillRect(Math.floor(this.x), Math.floor(this.y), this.size, this.size);
  }
}

const particles: Particle[] = [];
const canvas = document.getElementById("particle-canvas") as HTMLCanvasElement;
const pCtx = canvas.getContext("2d")!;

function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
resizeCanvas();
window.addEventListener("resize", resizeCanvas);

function spawnParticles(x: number, y: number, count: number, color: string) {
  for (let i = 0; i < count; i++) particles.push(new Particle(x, y, color));
}

(function animateParticles() {
  pCtx.clearRect(0, 0, canvas.width, canvas.height);
  for (let i = particles.length - 1; i >= 0; i--) {
    particles[i].update();
    particles[i].draw(pCtx);
    if (particles[i].life <= 0) particles.splice(i, 1);
  }
  requestAnimationFrame(animateParticles);
})();

// --- Gamification ---
const ACHIEVEMENTS: Record<string, { name: string; desc: string; check: (s: Stats) => boolean }> = {
  first_cmd: { name: "HELLO WORLD", desc: "Run your first command", check: s => s.cmds >= 1 },
  ten_cmds: { name: "GETTING STARTED", desc: "Run 10 commands", check: s => s.cmds >= 10 },
  fifty_cmds: { name: "POWER USER", desc: "Run 50 commands", check: s => s.cmds >= 50 },
  century: { name: "CENTURION", desc: "Run 100 commands", check: s => s.cmds >= 100 },
  streak_5: { name: "ON A ROLL", desc: "5 commands in 30s", check: s => s.streak >= 5 },
  streak_10: { name: "UNSTOPPABLE", desc: "10 commands in 30s", check: s => s.streak >= 10 },
  git_user: { name: "VERSION CTRL", desc: "Use git", check: s => s.gitCmds >= 1 },
  npm_user: { name: "NODE NINJA", desc: "Use npm/npx", check: s => s.npmCmds >= 1 },
  night_owl: { name: "NIGHT OWL", desc: "Terminal after midnight", check: () => new Date().getHours() < 5 },
  tab_hoarder: { name: "TAB HOARDER", desc: "Open 5 tabs", check: s => s.maxTabs >= 5 },
  organizer: { name: "ORGANIZED", desc: "Create a folder", check: s => s.foldersCreated >= 1 },
};

interface Stats {
  cmds: number; xp: number; level: number; streak: number;
  lastCmdTime: number; gitCmds: number; npmCmds: number;
  maxTabs: number; foldersCreated: number; unlocked: Set<string>;
}

const stats: Stats = {
  cmds: 0, xp: 0, level: 1, streak: 0, lastCmdTime: 0,
  gitCmds: 0, npmCmds: 0, maxTabs: 0, foldersCreated: 0,
  unlocked: new Set(),
};

function xpForLevel(level: number) { return level * 25; }

function addXP(amount: number) {
  stats.xp += amount;
  const needed = xpForLevel(stats.level);
  if (stats.xp >= needed) {
    stats.xp -= needed;
    stats.level++;
    playLevelUpSound();
    showToast(`LEVEL UP! LVL ${stats.level}`);
    spawnParticles(canvas.width / 2, canvas.height / 2, 40, "#39ff14");
  }
  updateHUD();
}

function checkAchievements() {
  for (const [id, ach] of Object.entries(ACHIEVEMENTS)) {
    if (!stats.unlocked.has(id) && ach.check(stats)) {
      stats.unlocked.add(id);
      playAchievementSound();
      showToast(`ACHIEVEMENT: ${ach.name} - ${ach.desc}`);
      addXP(15);
      spawnParticles(canvas.width - 100, canvas.height - 50, 25, "#ffe600");
    }
  }
}

function showToast(msg: string) {
  const toast = document.getElementById("achievements-toast")!;
  toast.textContent = msg;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 3000);
}

function updateHUD() {
  const needed = xpForLevel(stats.level);
  const pct = (stats.xp / needed) * 100;
  (document.getElementById("xp-fill") as HTMLElement).style.width = pct + "%";
  document.getElementById("xp-text")!.textContent = `LVL ${stats.level} · ${stats.xp}/${needed} XP`;
  document.getElementById("cmd-count")!.textContent = `${stats.cmds} cmds`;
  document.getElementById("status-streak")!.textContent = stats.streak > 1 ? `STREAK x${stats.streak}` : "";
}

function onCommand(input: string) {
  const now = Date.now();
  stats.cmds++;
  stats.streak = (now - stats.lastCmdTime < 30000) ? stats.streak + 1 : 1;
  stats.lastCmdTime = now;
  const lower = input.trim().toLowerCase();
  if (lower.startsWith("git ")) stats.gitCmds++;
  if (lower.startsWith("npm ") || lower.startsWith("npx ")) stats.npmCmds++;
  let xp = 5;
  if (stats.streak > 3) xp += stats.streak;
  playCommandSound();
  addXP(xp);
  checkAchievements();
  saveState();
  const r = document.getElementById("terminal-container")!.getBoundingClientRect();
  spawnParticles(r.left + Math.random() * r.width * 0.3, r.top + r.height * 0.5, 8, "#00fff7");
}

// --- Data model ---
interface TabSession {
  ptyId: number;
  term: Terminal;
  fitAddon: FitAddon;
  currentLine: string;
  number: number;
  name: string;
  folderId: string | null;
}

interface Folder {
  id: string;
  name: string;
  collapsed: boolean;
}

const tabSessions: Map<number, TabSession> = new Map();
const folders: Map<string, Folder> = new Map();
let activeTabId: number | null = null;
let tabCounter = 0;
let folderCounter = 0;
let draggedTabId: number | null = null;

const TERM_THEME = {
  background: "#0a0a1a", foreground: "#e0e0ff",
  cursor: "#00fff7", cursorAccent: "#0a0a1a",
  selectionBackground: "#00fff744", selectionForeground: "#ffffff",
  black: "#0a0a1a", red: "#ff3860", green: "#39ff14", yellow: "#ffe600",
  blue: "#00b4d8", magenta: "#ff00e4", cyan: "#00fff7", white: "#e0e0ff",
  brightBlack: "#4a4a6a", brightRed: "#ff6b8a", brightGreen: "#7dff6b",
  brightYellow: "#ffef5c", brightBlue: "#48cae4", brightMagenta: "#ff66f0",
  brightCyan: "#66fffa", brightWhite: "#ffffff",
};

const termContainer = document.getElementById("terminal-container")!;
const sidebarTree = document.getElementById("sidebar-tree")!;

// --- Sidebar rendering ---
function renderSidebar() {
  sidebarTree.innerHTML = "";

  // Loose tabs (no folder)
  const looseTabs = Array.from(tabSessions.values()).filter(t => t.folderId === null);
  for (const tab of looseTabs) {
    sidebarTree.appendChild(createTabEl(tab));
  }

  // Folders
  for (const folder of folders.values()) {
    const folderTabs = Array.from(tabSessions.values()).filter(t => t.folderId === folder.id);
    sidebarTree.appendChild(createFolderEl(folder, folderTabs));
  }
}

function createTabEl(tab: TabSession): HTMLElement {
  const el = document.createElement("div");
  el.className = "sidebar-tab" + (tab.ptyId === activeTabId ? " active" : "");
  el.draggable = true;
  el.innerHTML = `<span class="tab-icon">></span><span class="tab-label">${tab.name}</span><button class="tab-close">x</button>`;

  el.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).classList.contains("tab-close")) return;
    switchTab(tab.ptyId);
  });
  el.querySelector(".tab-close")!.addEventListener("click", () => closeTab(tab.ptyId));

  el.addEventListener("dragstart", (e) => {
    draggedTabId = tab.ptyId;
    e.dataTransfer!.effectAllowed = "move";
    el.style.opacity = "0.4";
  });
  el.addEventListener("dragend", () => {
    draggedTabId = null;
    el.style.opacity = "1";
  });

  return el;
}

function createFolderEl(folder: Folder, tabs: TabSession[]): HTMLElement {
  const el = document.createElement("div");
  el.className = "folder" + (folder.collapsed ? " collapsed" : "");

  const header = document.createElement("div");
  header.className = "folder-header";
  header.innerHTML = `
    <span class="folder-arrow">v</span>
    <span class="folder-icon">[=]</span>
    <span class="folder-name">${folder.name}</span>
    <span class="folder-count">${tabs.length}</span>
    <span class="folder-actions">
      <button class="folder-add" title="New tab in folder">+</button>
      <button class="folder-delete" title="Delete folder">x</button>
    </span>`;

  header.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains("folder-add")) {
      addTab(folder.id);
      return;
    }
    if (target.classList.contains("folder-delete")) {
      deleteFolder(folder.id);
      return;
    }
    folder.collapsed = !folder.collapsed;
    renderSidebar();
    playFolderSound();
  });

  // Drop target
  header.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";
    header.classList.add("drop-over");
  });
  header.addEventListener("dragleave", () => header.classList.remove("drop-over"));
  header.addEventListener("drop", (e) => {
    e.preventDefault();
    header.classList.remove("drop-over");
    if (draggedTabId !== null) {
      const tab = tabSessions.get(draggedTabId);
      if (tab) {
        tab.folderId = folder.id;
        renderSidebar();
        playFolderSound();
        saveState();
      }
    }
  });

  el.appendChild(header);

  const children = document.createElement("div");
  children.className = "folder-children";
  for (const tab of tabs) {
    children.appendChild(createTabEl(tab));
  }
  if (!folder.collapsed) {
    children.style.maxHeight = (tabs.length * 34 + 10) + "px";
  }
  el.appendChild(children);

  return el;
}

// --- Drop on sidebar root = remove from folder ---
sidebarTree.addEventListener("dragover", (e) => {
  if (e.target === sidebarTree) {
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";
  }
});
sidebarTree.addEventListener("drop", (e) => {
  if (e.target === sidebarTree && draggedTabId !== null) {
    e.preventDefault();
    const tab = tabSessions.get(draggedTabId);
    if (tab) {
      tab.folderId = null;
      renderSidebar();
    }
  }
});

// --- Tab/folder operations ---
async function addTab(folderId: string | null = null, savedName: string | null = null) {
  if (audioCtx.state === "suspended") audioCtx.resume();

  const ptyId: number = await invoke("pty_spawn");
  if (!savedName) tabCounter++;

  const term = new Terminal({
    cursorBlink: true, cursorStyle: "block",
    fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
    fontSize: 14, lineHeight: 1.2, theme: TERM_THEME,
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());

  const session: TabSession = {
    ptyId, term, fitAddon,
    currentLine: "", number: tabCounter, name: savedName || ("TERM " + tabCounter), folderId,
  };
  tabSessions.set(ptyId, session);

  stats.maxTabs = Math.max(stats.maxTabs, tabSessions.size);
  checkAchievements();

  term.onData((data: string) => {
    if (audioCtx.state === "suspended") audioCtx.resume();
    if (data === "\r") {
      if (session.currentLine.trim()) onCommand(session.currentLine);
      session.currentLine = "";
    } else if (data === "\x7f") {
      session.currentLine = session.currentLine.slice(0, -1);
    } else if (data.length === 1 && data >= " ") {
      session.currentLine += data;
      playKeySound();
    } else if (data.length > 1) {
      playKeySound();
    }
    invoke("pty_write", { id: ptyId, data });
  });

  playTabSound();
  switchTab(ptyId);
  renderSidebar();
  saveState();
}

function switchTab(id: number) {
  const session = tabSessions.get(id);
  if (!session) return;

  if (activeTabId !== null && activeTabId !== id) {
    const prev = tabSessions.get(activeTabId);
    if (prev && prev.term.element) {
      prev.term.element.style.display = "none";
    }
  }

  activeTabId = id;

  if (!session.term.element) {
    session.term.open(termContainer);
  } else {
    if (!termContainer.contains(session.term.element)) {
      termContainer.appendChild(session.term.element);
    }
    session.term.element.style.display = "";
  }

  session.fitAddon.fit();
  invoke("pty_resize", { id, cols: session.term.cols, rows: session.term.rows });
  session.term.focus();
  renderSidebar();
}

function closeTab(id: number) {
  const session = tabSessions.get(id);
  if (!session) return;

  invoke("pty_kill", { id });
  if (session.term.element && termContainer.contains(session.term.element)) {
    termContainer.removeChild(session.term.element);
  }
  session.term.dispose();
  tabSessions.delete(id);

  if (activeTabId === id) {
    activeTabId = null;
    const remaining = Array.from(tabSessions.keys());
    if (remaining.length > 0) {
      switchTab(remaining[remaining.length - 1]);
    }
  }

  if (tabSessions.size === 0) addTab();
  renderSidebar();
  saveState();
}

function addFolder() {
  if (audioCtx.state === "suspended") audioCtx.resume();
  folderCounter++;
  const id = "folder-" + folderCounter;
  folders.set(id, { id, name: "FOLDER " + folderCounter, collapsed: false });
  stats.foldersCreated++;
  checkAchievements();
  playFolderSound();
  renderSidebar();
  saveState();

  // Make folder name editable on creation
  setTimeout(() => {
    const nameEl = sidebarTree.querySelector(`.folder:last-child .folder-name`) as HTMLElement;
    if (nameEl) startRename(nameEl, id);
  }, 50);
}

function deleteFolder(folderId: string) {
  // Move tabs out of folder, don't kill them
  for (const tab of tabSessions.values()) {
    if (tab.folderId === folderId) tab.folderId = null;
  }
  folders.delete(folderId);
  renderSidebar();
  saveState();
}

function startTabRename(el: HTMLElement, ptyId: number) {
  const tab = tabSessions.get(ptyId);
  if (!tab) return;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "tab-rename-input";
  input.value = tab.name;

  const finish = () => {
    tab.name = input.value.trim() || tab.name;
    renderSidebar();
    saveState();
  };
  input.addEventListener("blur", finish);
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish();
    if (e.key === "Escape") { input.value = tab.name; finish(); }
  });
  input.addEventListener("click", (e) => e.stopPropagation());

  el.replaceWith(input);
  input.focus();
  input.select();
}

function startRename(el: HTMLElement, folderId: string) {
  const folder = folders.get(folderId);
  if (!folder) return;

  const input = document.createElement("input");
  input.type = "text";
  input.value = folder.name;
  input.style.cssText = `
    background: var(--bg-deep); border: 1px solid var(--neon-yellow);
    color: var(--neon-yellow); font-family: var(--pixel-font); font-size: 7px;
    padding: 1px 4px; width: 100%; outline: none;
  `;

  const finish = () => {
    folder.name = input.value.trim() || folder.name;
    renderSidebar();
    saveState();
  };
  input.addEventListener("blur", finish);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish();
    if (e.key === "Escape") { input.value = folder.name; finish(); }
  });

  el.replaceWith(input);
  input.focus();
  input.select();
}

// --- Event listeners ---
listen<{ id: number; data: string }>("pty-output", (event) => {
  const session = tabSessions.get(event.payload.id);
  if (session) session.term.write(event.payload.data);
});

listen<number>("pty-exit", (event) => closeTab(event.payload));

window.addEventListener("resize", () => {
  if (activeTabId !== null) {
    const session = tabSessions.get(activeTabId);
    if (session) {
      session.fitAddon.fit();
      invoke("pty_resize", { id: activeTabId, cols: session.term.cols, rows: session.term.rows });
    }
  }
});

document.getElementById("btn-new-tab")!.addEventListener("click", () => addTab());
document.getElementById("btn-new-folder")!.addEventListener("click", () => addFolder());

document.getElementById("sidebar-toggle")!.addEventListener("click", () => {
  const sidebar = document.getElementById("sidebar")!;
  sidebar.classList.toggle("collapsed");
  // Refit active terminal after transition
  setTimeout(() => {
    if (activeTabId !== null) {
      const s = tabSessions.get(activeTabId);
      if (s) { s.fitAddon.fit(); invoke("pty_resize", { id: activeTabId, cols: s.term.cols, rows: s.term.rows }); }
    }
  }, 250);
});

// Double-click to rename tabs and folders
sidebarTree.addEventListener("dblclick", (e) => {
  const target = e.target as HTMLElement;
  if (target.classList.contains("folder-name")) {
    const folderId = Array.from(folders.keys()).find(id => folders.get(id)!.name === target.textContent);
    if (folderId) startRename(target, folderId);
  }
  if (target.classList.contains("tab-label")) {
    target.closest(".sidebar-tab") as HTMLElement;
    const ptyId = Array.from(tabSessions.keys()).find(id => tabSessions.get(id)!.name === target.textContent);
    if (ptyId !== undefined) startTabRename(target, ptyId);
  }
});

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "t") { e.preventDefault(); addTab(); }
  if (e.ctrlKey && e.key === "w") { e.preventDefault(); if (activeTabId !== null) closeTab(activeTabId); }
  if (e.ctrlKey && e.key === "Tab") {
    e.preventDefault();
    const ids = Array.from(tabSessions.keys());
    if (ids.length < 2 || activeTabId === null) return;
    const idx = ids.indexOf(activeTabId);
    const next = e.shiftKey ? ids[(idx - 1 + ids.length) % ids.length] : ids[(idx + 1) % ids.length];
    switchTab(next);
    playTabSound();
  }
  if (e.ctrlKey && e.key === "b") {
    e.preventDefault();
    document.getElementById("sidebar")!.classList.toggle("collapsed");
    setTimeout(() => {
      if (activeTabId !== null) {
        const s = tabSessions.get(activeTabId);
        if (s) { s.fitAddon.fit(); invoke("pty_resize", { id: activeTabId, cols: s.term.cols, rows: s.term.rows }); }
      }
    }, 250);
  }
});

// --- Window controls ---
const appWindow = getCurrentWindow();
document.getElementById("btn-minimize")!.addEventListener("click", () => appWindow.minimize());
document.getElementById("btn-maximize")!.addEventListener("click", async () => {
  (await appWindow.isMaximized()) ? appWindow.unmaximize() : appWindow.maximize();
});
document.getElementById("btn-close")!.addEventListener("click", () => shutdown());

// --- Persistence ---
interface SaveData {
  tabs: { name: string; folderId: string | null }[];
  folders: { id: string; name: string; collapsed: boolean }[];
  stats: {
    cmds: number; xp: number; level: number;
    gitCmds: number; npmCmds: number; maxTabs: number;
    foldersCreated: number; unlocked: string[];
  };
  tabCounter: number;
  folderCounter: number;
}

const SAVE_FILE = "state.json";

async function saveState() {
  try {
    const data: SaveData = {
      tabs: Array.from(tabSessions.values()).map(t => ({
        name: t.name,
        folderId: t.folderId,
      })),
      folders: Array.from(folders.values()),
      stats: {
        cmds: stats.cmds, xp: stats.xp, level: stats.level,
        gitCmds: stats.gitCmds, npmCmds: stats.npmCmds,
        maxTabs: stats.maxTabs, foldersCreated: stats.foldersCreated,
        unlocked: Array.from(stats.unlocked),
      },
      tabCounter,
      folderCounter,
    };
    const dirExists = await exists("", { baseDir: BaseDirectory.AppData });
    if (!dirExists) {
      await mkdir("", { baseDir: BaseDirectory.AppData, recursive: true });
    }
    await writeTextFile(SAVE_FILE, JSON.stringify(data, null, 2), { baseDir: BaseDirectory.AppData });
  } catch (e) {
    console.error("save failed:", e);
  }
}

async function loadState(): Promise<SaveData | null> {
  try {
    const fileExists = await exists(SAVE_FILE, { baseDir: BaseDirectory.AppData });
    if (!fileExists) return null;
    const raw = await readTextFile(SAVE_FILE, { baseDir: BaseDirectory.AppData });
    return JSON.parse(raw) as SaveData;
  } catch (e) {
    console.error("load failed:", e);
    return null;
  }
}

async function boot() {
  const saved = await loadState();

  if (saved) {
    // Restore stats
    stats.cmds = saved.stats.cmds;
    stats.xp = saved.stats.xp;
    stats.level = saved.stats.level;
    stats.gitCmds = saved.stats.gitCmds;
    stats.npmCmds = saved.stats.npmCmds;
    stats.maxTabs = saved.stats.maxTabs;
    stats.foldersCreated = saved.stats.foldersCreated;
    stats.unlocked = new Set(saved.stats.unlocked);
    tabCounter = saved.tabCounter;
    folderCounter = saved.folderCounter;

    // Restore folders
    for (const f of saved.folders) {
      folders.set(f.id, { id: f.id, name: f.name, collapsed: f.collapsed });
    }

    // Restore tabs (each gets a fresh PTY but keeps name/folder)
    for (const t of saved.tabs) {
      await addTab(t.folderId, t.name);
    }
  }

  if (tabSessions.size === 0) {
    await addTab();
  }

  updateHUD();
}

// Auto-save periodically and on close
setInterval(saveState, 30000);

async function shutdown() {
  try {
    await Promise.race([
      saveState(),
      new Promise(r => setTimeout(r, 2000)),
    ]);
  } catch (_) {}
  for (const id of tabSessions.keys()) {
    try { invoke("pty_kill", { id }); } catch (_) {}
  }
  await appWindow.destroy();
}

appWindow.onCloseRequested(async (event) => {
  event.preventDefault();
  await shutdown();
});

// --- Project panel ---
interface ProjectFiles {
  path: string;
  now_md: string | null;
  ideas_md: string | null;
  shipped_md: string | null;
  gantry_plan: string | null;
  gantry_design: string | null;
  gantry_conventions: string | null;
  has_claude_dir: boolean;
  has_gantry: boolean;
}

let currentProjectPath: string | null = null;

function parseNowMd(raw: string): string {
  const lines = raw.split("\n").filter(l => l.trim() && !l.startsWith("#"));
  return lines.slice(0, 5).join("\n") || "no active work";
}

function countIdeas(raw: string): number {
  return raw.split("\n").filter(l => /^[-*]\s/.test(l.trim())).length;
}

function parseShipped(raw: string): string[] {
  return raw.split("\n")
    .filter(l => /^[-*]\s/.test(l.trim()))
    .slice(-5)
    .reverse()
    .map(l => l.replace(/^[-*]\s+/, "").trim());
}

interface GantryPhaseInfo {
  name: string;
  status: "pending" | "active" | "done";
}

function parseGantryPlan(raw: string): { pipeline: string; phases: GantryPhaseInfo[] } {
  let pipeline = "plan";

  const phases: GantryPhaseInfo[] = [];
  const phaseRegex = /^##\s+(?:phase\s+\d+[:\s]*)?(.+)/gim;
  let match;
  let foundActive = false;

  while ((match = phaseRegex.exec(raw)) !== null) {
    const name = match[1].trim();
    const sectionStart = match.index + match[0].length;
    const nextSection = raw.indexOf("\n## ", sectionStart);
    const section = raw.slice(sectionStart, nextSection === -1 ? undefined : nextSection);

    const checkboxes = section.match(/- \[[ x]\]/g) || [];
    const checked = section.match(/- \[x\]/gi) || [];
    const allDone = checkboxes.length > 0 && checked.length === checkboxes.length;

    let status: "pending" | "active" | "done" = "pending";
    if (allDone && checkboxes.length > 0) {
      status = "done";
    } else if (!foundActive && checkboxes.length > 0 && checked.length > 0) {
      status = "active";
      foundActive = true;
    } else if (!foundActive && !allDone && checkboxes.length > 0) {
      status = "active";
      foundActive = true;
    }

    phases.push({ name, status });
  }

  if (phases.some(p => p.status === "active")) pipeline = "build";
  else if (phases.every(p => p.status === "done") && phases.length > 0) pipeline = "review";

  if (raw.toLowerCase().includes("design")) pipeline = phases.length === 0 ? "design" : pipeline;

  return { pipeline, phases };
}

function renderProjectPanel(files: ProjectFiles) {
  const panel = document.getElementById("project-panel")!;
  const content = document.getElementById("project-content")!;

  if (!files.has_claude_dir && !files.has_gantry) {
    panel.classList.add("hidden");
    return;
  }

  panel.classList.remove("hidden");
  let html = "";

  if (files.now_md) {
    const now = parseNowMd(files.now_md);
    html += `<div class="project-section">
      <div class="project-section-title">NOW</div>
      <div class="project-now">${escapeHtml(now)}</div>
    </div>`;
  }

  if (files.gantry_plan) {
    const { pipeline, phases } = parseGantryPlan(files.gantry_plan);
    const stages = ["design", "plan", "build", "review"];
    const stageIdx = stages.indexOf(pipeline);

    html += `<div class="project-section">
      <div class="project-section-title">GANTRY</div>
      <div class="gantry-pipeline">
        ${stages.map((s, i) => {
          let cls = "";
          if (i < stageIdx) cls = "done";
          else if (i === stageIdx) cls = "active";
          return `<div class="gantry-stage ${cls}">${s.toUpperCase()}</div>`;
        }).join("")}
      </div>`;

    if (phases.length > 0) {
      html += `<div class="gantry-phases">`;
      for (const p of phases) {
        html += `<div class="gantry-phase ${p.status}">
          <div class="gantry-phase-dot"></div>
          <span>${escapeHtml(p.name)}</span>
        </div>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
  }

  if (files.ideas_md) {
    const count = countIdeas(files.ideas_md);
    html += `<div class="project-section">
      <div class="project-section-title">IDEAS</div>
      <div class="project-ideas-count">${count} idea${count !== 1 ? "s" : ""} parked</div>
    </div>`;
  }

  if (files.shipped_md) {
    const items = parseShipped(files.shipped_md);
    if (items.length > 0) {
      html += `<div class="project-section">
        <div class="project-section-title">SHIPPED</div>
        ${items.map(i => `<div class="project-shipped-item">${escapeHtml(i)}</div>`).join("")}
      </div>`;
    }
  }

  if (!html) {
    html = `<div class="project-empty">no project files detected</div>`;
  }

  content.innerHTML = html;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function scanProject(path: string) {
  try {
    const files: ProjectFiles = await invoke("project_scan", { path });
    renderProjectPanel(files);
  } catch (_) {}
}

async function watchProject(path: string) {
  try {
    await invoke("project_watch", { path });
  } catch (_) {}
}

async function initProjectPanel() {
  const cwd: string | null = await invoke("get_initial_cwd");
  const path = cwd || "C:\\Users\\atk67";
  currentProjectPath = path;

  await scanProject(path);
  await watchProject(path);

  listen<ProjectFiles>("project-updated", (event) => {
    renderProjectPanel(event.payload);
  });
}

document.getElementById("project-refresh")!.addEventListener("click", () => {
  if (currentProjectPath) scanProject(currentProjectPath);
});

// Poll on terminal focus (hybrid: supplements the file watcher for ClauDHD files)
window.addEventListener("focus", () => {
  if (currentProjectPath) scanProject(currentProjectPath);
});

// --- Boot ---
boot();
initProjectPanel();
