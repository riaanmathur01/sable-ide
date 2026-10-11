// @ts-check
/** @typedef {import("../sable").Sable} Sable */

/** "14:05" (24-hour) or "2:05 PM" (12-hour), in the user's locale. */
function formatTime(date, hour12) {
  return new Intl.DateTimeFormat(undefined, {
    hour: hour12 ? "numeric" : "2-digit",
    minute: "2-digit",
    hourCycle: hour12 ? "h12" : "h23",
  }).format(date);
}

/** "Sunday, 11 October 2026", in the user's locale. */
function formatDate(date) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(date);
}

/** Whether the user's locale writes times with AM/PM. */
function localePrefers12Hour() {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hour12 === true;
}

/** Milliseconds until the next minute starts (plus a little, so we land just past it). */
function msToNextMinute(date) {
  return 60_000 - (date.getSeconds() * 1000 + date.getMilliseconds()) + 50;
}

/** @type {ReturnType<typeof setTimeout> | undefined} */
let timer;
let stopped = false;

/** @param {Sable} sable */
export async function activate(sable) {
  stopped = false;
  let hour12 = (await sable.storage.get("hour12")) ?? localePrefers12Hour();

  const render = async () => {
    const now = new Date();
    await sable.statusBar.set(formatTime(now, hour12), {
      tooltip: `${formatDate(now)} — click for ${hour12 ? "24-hour" : "12-hour"} time`,
      command: "toggle",
    });
  };

  // Redraw as each minute starts, rather than polling every second.
  const tick = async () => {
    if (stopped) return;
    await render();
    if (!stopped) timer = setTimeout(tick, msToNextMinute(new Date()));
  };

  sable.commands.register("toggle", "Toggle 12/24-Hour Time", async () => {
    hour12 = !hour12;
    await sable.storage.set("hour12", hour12);
    await render();
  });

  await tick();
}

export function deactivate() {
  stopped = true;
  clearTimeout(timer);
}
