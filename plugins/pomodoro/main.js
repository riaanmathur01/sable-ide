// @ts-check
/** @typedef {import("../sable").Sable} Sable */

/** @type {Record<"focus" | "break", { minutes: number; icon: string; label: string }>} */
const PERIODS = {
  focus: { minutes: 25, icon: "🍅", label: "Focus" },
  break: { minutes: 5, icon: "☕", label: "Break" },
};

const pad = (n) => String(n).padStart(2, "0");

/** 754_000 ms → "12:34" (rounded up, so it shows 00:01 until the very end). */
function formatRemaining(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

/** The local date as "2026-10-11", to know which day a session counts towards. */
function dayKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** @type {ReturnType<typeof setInterval> | undefined} */
let timer;

/** @param {Sable} sable */
export async function activate(sable) {
  /** The running period, or null when idle. @type {{ kind: "focus" | "break"; endsAt: number } | null} */
  let current = null;
  /** Focus sessions completed, and on which day. @type {{ day: string; count: number }} */
  let completed = (await sable.storage.get("completed")) ?? { day: dayKey(new Date()), count: 0 };

  const completedToday = () => (completed.day === dayKey(new Date()) ? completed.count : 0);

  const render = async () => {
    const today = `${plural(completedToday(), "focus session")} today`;
    if (current) {
      const { icon, label } = PERIODS[current.kind];
      await sable.statusBar.set(`${icon} ${formatRemaining(current.endsAt - Date.now())}`, {
        tooltip: `${label} · ${today} — click to stop`,
        command: "toggle",
      });
    } else {
      await sable.statusBar.set(`🍅 ${completedToday()} today`, {
        tooltip: `Pomodoro: ${today} — click to start a ${PERIODS.focus.minutes}-minute focus session`,
        command: "toggle",
      });
    }
  };

  const stopTimer = () => {
    clearInterval(timer);
    timer = undefined;
  };

  const start = async (kind) => {
    stopTimer();
    current = { kind, endsAt: Date.now() + PERIODS[kind].minutes * 60_000 };
    timer = setInterval(tick, 1000);
    await render();
    await sable.window.showMessage(`${PERIODS[kind].label} started: ${PERIODS[kind].minutes} minutes`);
  };

  // A period ran out: count it (if it was a focus session) and say so.
  const finish = async () => {
    if (!current) return;
    const { kind } = current;
    current = null;
    stopTimer();
    if (kind === "focus") {
      completed = { day: dayKey(new Date()), count: completedToday() + 1 };
      await sable.storage.set("completed", completed);
      await sable.window.showMessage(`Focus session done (${completed.count} today) — time for a break`);
    } else {
      await sable.window.showMessage("Break over — ready to focus?");
    }
    await render();
  };

  const tick = async () => {
    if (!current) return;
    if (Date.now() >= current.endsAt) await finish();
    else await render();
  };

  const stop = async () => {
    if (!current) return;
    current = null;
    stopTimer();
    await render();
    await sable.window.showMessage("Pomodoro stopped");
  };

  sable.commands.register("focus", `Start Focus (${PERIODS.focus.minutes} min)`, () => start("focus"));
  sable.commands.register("break", `Start Break (${PERIODS.break.minutes} min)`, () => start("break"));
  sable.commands.register("stop", "Stop", stop);
  // The status-bar item: start a focus session when idle, stop when running.
  sable.commands.register("toggle", "Start or Stop", () => (current ? stop() : start("focus")));

  await render();
}

export function deactivate() {
  clearInterval(timer);
  timer = undefined;
}
