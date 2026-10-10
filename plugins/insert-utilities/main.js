// @ts-check
/** @typedef {import("../sable").Sable} Sable */

const pad = (n) => String(n).padStart(2, "0");
const LOREM =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.";

/** @type {Record<string, [string, () => string]>} */
const INSERTS = {
  date: ["Insert Date (YYYY-MM-DD)", () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }],
  time: ["Insert Time (HH:MM)", () => {
    const d = new Date();
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }],
  datetime: ["Insert Date and Time (ISO 8601)", () => new Date().toISOString()],
  timestamp: ["Insert Unix Timestamp", () => String(Math.floor(Date.now() / 1000))],
  uuid: ["Insert UUID", () => crypto.randomUUID()],
  lorem: ["Insert Lorem Ipsum", () => LOREM],
};

/** @param {Sable} sable */
export function activate(sable) {
  for (const [id, [title, make]] of Object.entries(INSERTS)) {
    sable.commands.register(id, title, async () => {
      if (!(await sable.editor.active())) return sable.window.showError("Open a file first");
      await sable.editor.replaceSelection(make());
    });
  }
}
