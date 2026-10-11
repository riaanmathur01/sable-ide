# Pomodoro

A focus timer in the status bar, for the
[Pomodoro technique](https://en.wikipedia.org/wiki/Pomodoro_Technique):
work for 25 minutes, then take a 5-minute break. It counts the focus
sessions you finish each day.

## How to use

1. Click **🍅 0 today** in the status bar to start a 25-minute focus
   session. The item counts down: **🍅 24:59**.
2. When the time is up, Sable tells you in the status bar and the day's
   count goes up by one.
3. Start a break from the command palette: ⇧⌘P (Ctrl+Shift+P on
   Windows/Linux), then **Pomodoro: Start Break (5 min)**. It shows as
   **☕ 04:59**.
4. To stop early, click the timer, or run **Pomodoro: Stop**. A stopped
   session doesn't count.

**Pomodoro: Start Focus (25 min)** starts a focus session from the
palette. Starting a session while another is running starts over.
Hover over the timer to see how many sessions you've finished today. The
count starts again at zero each day.

Permissions: none. Needs Sable 0.3.6 or newer.
