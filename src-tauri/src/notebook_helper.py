"""Sable's Jupyter kernel helper (shipped inside the app, see notebook.rs).

Runs with the Python interpreter selected for the workspace and relays
Jupyter's messaging protocol as JSON lines:

  stdin  (from Sable):  {"op": "start", "kernel": "python3", "cwd": "/dir"}
                        {"op": "execute", "req": "r1", "code": "print(1)"}
                        {"op": "complete" | "inspect", "req": "r2", "code": "...", "cursor_pos": 3}
                        {"op": "input_reply", "value": "text"}
                        {"op": "interrupt"} | {"op": "restart"} | {"op": "shutdown"}
  stdout (to Sable):    {"type": "status", "state": "starting" | "idle" | "busy" | "restarting" | "dead"}
                        {"type": "started", "kernel": "python3", "info": {...kernel_info...}}
                        {"type": "iopub", "req": "r1", "msg_type": "stream", "content": {...}, "metadata": {...}}
                        {"type": "reply", "req": "r1", "msg_type": "execute_reply", "content": {...}}
                        {"type": "input_request", "req": "r1", "prompt": "> ", "password": false}
                        {"type": "missing", "packages": ["ipykernel"], "python": "/usr/bin/python3"}
                        {"type": "error", "message": "..."}

`python helper.py --specs` prints the kernelspecs as one JSON line and exits.

All sockets are used from the main thread only (ZeroMQ sockets aren't
thread-safe); a reader thread just queues the lines arriving on stdin.
When stdin closes (Sable quit or closed the notebook), the kernel is
shut down and the helper exits.
"""

import json
import os
import queue
import sys
import threading
import time

_out_lock = threading.Lock()


def send(message):
    line = json.dumps(message, default=str, ensure_ascii=True)
    with _out_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def missing_packages():
    import importlib.util

    return [name for name in ("jupyter_client", "ipykernel") if importlib.util.find_spec(name) is None]


def list_specs():
    missing = missing_packages()
    if "jupyter_client" in missing:
        return {"type": "specs", "specs": {}, "missing": missing, "python": sys.executable}
    from jupyter_client.kernelspec import KernelSpecManager

    specs = {}
    try:
        for name, entry in KernelSpecManager().get_all_specs().items():
            spec = entry.get("spec", {})
            specs[name] = {
                "display_name": spec.get("display_name", name),
                "language": spec.get("language", ""),
            }
    except Exception as error:  # a broken kernel.json shouldn't hide the others
        send({"type": "error", "message": "Couldn't list kernels: %s" % error})
    return {"type": "specs", "specs": specs, "missing": missing, "python": sys.executable}


class Relay:
    def __init__(self):
        self.commands = queue.Queue()
        self.manager = None
        self.client = None
        self.kernel_name = None
        # Kernel msg_id -> Sable's request id.
        self.requests = {}
        self.last_alive_check = 0.0
        self.dead = False

    # --- stdin ------------------------------------------------------------------------
    def read_stdin(self):
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                self.commands.put(json.loads(line))
            except ValueError:
                send({"type": "error", "message": "bad command line"})
        self.commands.put({"op": "eof"})

    # --- kernel lifecycle ---------------------------------------------------------------
    def start(self, kernel, cwd):
        missing = missing_packages()
        if "jupyter_client" in missing:
            send({"type": "missing", "packages": missing, "python": sys.executable})
            return
        from jupyter_client.kernelspec import NoSuchKernel
        from jupyter_client.manager import KernelManager

        name = kernel or "python3"
        send({"type": "status", "state": "starting"})
        try:
            self.manager = KernelManager(kernel_name=name)
            # Shut down within Sable's patience (notebook.rs waits 8 s).
            self.manager.shutdown_wait_time = 3.0
            # The kernel's own interpreter (python3 → this one) needs ipykernel.
            self.manager.kernel_spec
        except NoSuchKernel:
            self.manager = None
            if name == "python3" and "ipykernel" in missing:
                send({"type": "missing", "packages": missing, "python": sys.executable})
            else:
                send({"type": "error", "message": "No kernel named %s" % name})
                send({"type": "status", "state": "dead"})
            return
        try:
            kwargs = {}
            if cwd and os.path.isdir(cwd):
                kwargs["cwd"] = cwd
            self.manager.start_kernel(**kwargs)
            self.client = self.manager.client()
            self.client.allow_stdin = True
            self.client.start_channels()
            self.client.wait_for_ready(timeout=120)
        except Exception as error:
            send({"type": "error", "message": "The kernel didn't start: %s" % error})
            send({"type": "status", "state": "dead"})
            self.stop()
            return
        self.kernel_name = name
        self.dead = False
        info = self.kernel_info()
        send({"type": "started", "kernel": name, "info": info})
        send({"type": "status", "state": "idle"})

    def kernel_info(self):
        try:
            msg_id = self.client.kernel_info()
            deadline = time.time() + 10
            while time.time() < deadline:
                reply = self.client.get_shell_msg(timeout=deadline - time.time())
                if reply["parent_header"].get("msg_id") == msg_id:
                    return reply["content"]
        except Exception:
            pass
        return {}

    def stop(self):
        if self.client is not None:
            try:
                self.client.stop_channels()
            except Exception:
                pass
            self.client = None
        if self.manager is not None:
            try:
                self.manager.shutdown_kernel(now=False)
            except Exception:
                try:
                    self.manager.shutdown_kernel(now=True)
                except Exception:
                    pass
            self.manager = None

    # --- commands ----------------------------------------------------------------------
    def handle(self, command):
        op = command.get("op")
        if op == "start":
            self.stop()
            self.start(command.get("kernel"), command.get("cwd"))
            return True
        if op in ("shutdown", "eof"):
            self.stop()
            send({"type": "status", "state": "dead"})
            return False
        if op == "specs":
            send(list_specs())
            return True
        if self.client is None:
            if op in ("execute", "complete", "inspect"):
                send({"type": "reply", "req": command.get("req"), "msg_type": op + "_reply",
                      "content": {"status": "error", "ename": "NoKernel", "evalue": "No kernel is running"}})
            return True
        req = command.get("req")
        if op == "execute":
            msg_id = self.client.execute(command.get("code", ""), allow_stdin=True,
                                         stop_on_error=command.get("stop_on_error", True))
            self.requests[msg_id] = req
        elif op == "complete":
            code = command.get("code", "")
            msg_id = self.client.complete(code, command.get("cursor_pos", len(code)))
            self.requests[msg_id] = req
        elif op == "inspect":
            code = command.get("code", "")
            msg_id = self.client.inspect(code, command.get("cursor_pos", len(code)),
                                         command.get("detail_level", 0))
            self.requests[msg_id] = req
        elif op == "input_reply":
            self.client.input(command.get("value", ""))
        elif op == "interrupt":
            try:
                self.manager.interrupt_kernel()
            except Exception as error:
                send({"type": "error", "message": "Couldn't interrupt: %s" % error})
        elif op == "restart":
            send({"type": "status", "state": "restarting"})
            try:
                self.manager.restart_kernel(now=False)
                self.client.wait_for_ready(timeout=120)
                self.requests.clear()
                self.dead = False
                send({"type": "restarted"})
                send({"type": "status", "state": "idle"})
            except Exception as error:
                send({"type": "error", "message": "The kernel didn't restart: %s" % error})
                send({"type": "status", "state": "dead"})
        return True

    # --- messages from the kernel ---------------------------------------------------------
    def forward(self, kind, msg):
        parent = msg.get("parent_header") or {}
        req = self.requests.get(parent.get("msg_id"))
        msg_type = msg["header"]["msg_type"]
        if kind == "iopub":
            if msg_type == "status":
                send({"type": "status", "state": msg["content"].get("execution_state"), "req": req})
                return
            send({"type": "iopub", "req": req, "msg_type": msg_type,
                  "content": msg.get("content", {}), "metadata": msg.get("metadata", {})})
        elif kind == "shell":
            send({"type": "reply", "req": req, "msg_type": msg_type, "content": msg.get("content", {})})
            # Completions and inspections are done with their reply;
            # executions still get their final idle status on iopub.
            if msg_type in ("complete_reply", "inspect_reply"):
                self.requests.pop(parent.get("msg_id"), None)
        elif kind == "stdin" and msg_type == "input_request":
            content = msg.get("content", {})
            send({"type": "input_request", "req": req, "prompt": content.get("prompt", ""),
                  "password": bool(content.get("password"))})

    def poll(self):
        import zmq

        channels = [
            ("iopub", self.client.iopub_channel),
            ("shell", self.client.shell_channel),
            ("stdin", self.client.stdin_channel),
        ]
        poller = zmq.Poller()
        for _, channel in channels:
            poller.register(channel.socket, zmq.POLLIN)
        ready = dict(poller.poll(20))
        # iopub first: a cell's outputs before its reply.
        for kind, channel in channels:
            if channel.socket in ready:
                while channel.msg_ready():
                    self.forward(kind, channel.get_msg(timeout=0))
        now = time.time()
        if now - self.last_alive_check > 1.0:
            self.last_alive_check = now
            if not self.dead and self.manager is not None and not self.manager.is_alive():
                self.dead = True
                send({"type": "status", "state": "dead"})

    def run(self):
        threading.Thread(target=self.read_stdin, daemon=True).start()
        while True:
            try:
                timeout = 0 if self.client is not None else 0.5
                command = self.commands.get(timeout=timeout) if timeout else self.commands.get_nowait()
            except queue.Empty:
                command = None
            if command is not None:
                try:
                    if not self.handle(command):
                        return
                except Exception as error:
                    send({"type": "error", "message": "%s: %s" % (type(error).__name__, error)})
                continue
            if self.client is not None:
                try:
                    self.poll()
                except Exception as error:
                    send({"type": "error", "message": "%s: %s" % (type(error).__name__, error)})
                    time.sleep(0.2)


def main():
    if "--specs" in sys.argv:
        send(list_specs())
        return
    send({"type": "ready", "python": sys.executable})
    relay = Relay()
    try:
        relay.run()
    finally:
        relay.stop()


if __name__ == "__main__":
    main()
