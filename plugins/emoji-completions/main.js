// @ts-check
/** @typedef {import("../sable").Sable} Sable */

/** GitHub's shortcodes for common emoji. */
const EMOJI = {
  smile: "😄", grin: "😁", joy: "😂", wink: "😉", blush: "😊", heart_eyes: "😍", thinking: "🤔",
  sunglasses: "😎", neutral_face: "😐", confused: "😕", cry: "😢", sob: "😭", angry: "😠", scream: "😱",
  sweat_smile: "😅", upside_down_face: "🙃", partying_face: "🥳", exploding_head: "🤯", skull: "💀",
  thumbsup: "👍", thumbsdown: "👎", clap: "👏", wave: "👋", pray: "🙏", muscle: "💪", ok_hand: "👌",
  raised_hands: "🙌", point_right: "👉", eyes: "👀", brain: "🧠",
  heart: "❤️", broken_heart: "💔", sparkles: "✨", star: "⭐", fire: "🔥", zap: "⚡", boom: "💥",
  tada: "🎉", rocket: "🚀", trophy: "🏆", gift: "🎁", bulb: "💡", memo: "📝", books: "📚",
  warning: "⚠️", x: "❌", white_check_mark: "✅", heavy_check_mark: "✔️", question: "❓", exclamation: "❗",
  lock: "🔒", key: "🔑", bug: "🐛", wrench: "🔧", hammer: "🔨", gear: "⚙️", package: "📦", link: "🔗",
  construction: "🚧", recycle: "♻️", lipstick: "💄", art: "🎨", rotating_light: "🚨", pushpin: "📌",
  calendar: "📅", hourglass: "⌛", coffee: "☕", pizza: "🍕", computer: "💻", iphone: "📱",
  chart_with_upwards_trend: "📈", money_with_wings: "💸", earth_americas: "🌎", sunny: "☀️", rainbow: "🌈",
  cat: "🐱", dog: "🐶", unicorn: "🦄", snake: "🐍", crab: "🦀", see_no_evil: "🙈", hundred: "💯",
};

/** @param {Sable} sable */
export function activate(sable) {
  const provide = ({ linePrefix }) => {
    // ":" then letters, right before the cursor (not inside a word, so
    // "a:b" and "12:30" don't trigger).
    const match = /(?:^|[^\w:]):([a-z0-9_+-]*)$/i.exec(linePrefix);
    if (!match) return [];
    const typed = match[1].toLowerCase();
    return Object.entries(EMOJI)
      .filter(([name]) => name.includes(typed))
      // All of them (there are few): the editor asks once, at the ":", and
      // narrows this list itself as you type on.
      .sort(([a], [b]) => Number(!a.startsWith(typed)) - Number(!b.startsWith(typed)) || a.localeCompare(b))
      .map(([name, emoji]) => ({
        label: `:${name}:`,
        insertText: emoji,
        detail: emoji,
        kind: "value",
        // Replace the ":" and what's been typed after it.
        replace: typed.length + 1,
      }));
  };
  for (const language of ["markdown", "plaintext"]) {
    sable.languages.registerCompletions(language, provide, { triggerCharacters: [":"] });
  }
}
