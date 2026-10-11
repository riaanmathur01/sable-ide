# Timestamps

Makes Unix timestamps readable. Hover one to see the date it stands for;
convert between timestamps and ISO 8601 dates; insert the current time.

## Reading a timestamp (hover)

1. Rest the pointer on a 10-digit timestamp in seconds (`1700000000`) or
   a 13-digit one in milliseconds (`1700000000000`), in any file: code,
   logs, JSON.
2. A tooltip shows:
   - the date and time in UTC, as ISO 8601 (`2023-11-14T22:13:20Z`)
   - the same moment in your time zone
   - how long ago (or from now) it is

## Converting

1. **Select** a timestamp or a date, or just put the cursor on one.
2. Open the **command palette**: ⇧⌘P (Ctrl+Shift+P on Windows/Linux).
3. Run **Timestamps: Convert Timestamp ↔ Date** (typing `timestamp`
   finds it).
4. It's replaced in one step (⌘Z undoes it):
   - a timestamp becomes an ISO date-time in UTC: `1700000000` →
     `2023-11-14T22:13:20Z` (13 digits or more are read as
     milliseconds)
   - a date becomes a timestamp in seconds: `2023-11-14T22:13:20Z` →
     `1700000000`

A selected date can be anything JavaScript reads, such as
`2024-05-01`, `2024-05-01 12:30` or `2024-05-01T12:30:00+02:00`. A
date-time without a time zone counts as your local time, and a date
alone as midnight UTC.

## Inserting the time

In the command palette, run **Timestamps: Insert Unix Timestamp**
(seconds, like `1700000000`) or **Timestamps: Insert ISO Date-Time**
(UTC, like `2023-11-14T22:13:20Z`). It goes in at the cursor, replacing
any selection.

Permissions: `editor` (to read and change the file). Needs Sable 0.3.6
or newer.
