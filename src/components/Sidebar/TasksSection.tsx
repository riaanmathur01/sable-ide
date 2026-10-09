import { useState } from "react";
import { ChevronDown, ChevronRight, Play, RefreshCw } from "lucide-react";
import { useTasksStore } from "../../store/tasksStore";
import "./TasksSection.css";

/** The project's scripts and build commands, under the file tree. */
export function TasksSection() {
  const tasks = useTasksStore((state) => state.tasks);
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem("sable.tasksOpen") !== "false";
    } catch {
      return true;
    }
  });
  if (tasks.length === 0) return null;
  const Chevron = open ? ChevronDown : ChevronRight;
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem("sable.tasksOpen", String(!open));
    } catch {
      /* not remembered */
    }
  };
  return (
    <div className={open ? "tasks-section open" : "tasks-section"}>
      <div className="tasks-header" onClick={toggle}>
        <Chevron size={13} strokeWidth={1.5} />
        <span>Tasks</span>
        <span className="tasks-count">{tasks.length}</span>
        <button
          className="tasks-reload"
          title="Reload tasks"
          onClick={(event) => {
            event.stopPropagation();
            void useTasksStore.getState().load();
          }}
        >
          <RefreshCw size={12} strokeWidth={1.5} />
        </button>
      </div>
      {open && (
        <div className="tasks-list">
          {tasks.map((task) => (
            <div
              key={task.id}
              className="tasks-row"
              title={`${task.command}${task.detail ? `\n${task.detail}` : ""}`}
              onClick={() => useTasksStore.getState().run(task)}
              role="button"
            >
              <Play size={11} strokeWidth={1.75} className="tasks-play" />
              <span className="tasks-label">{task.label}</span>
              <span className="tasks-source">{task.source}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
