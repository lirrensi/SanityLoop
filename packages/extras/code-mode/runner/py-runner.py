#!/usr/bin/env python3
"""SanityLoop code-mode Python kernel runner.

One long-lived process per (session, cwd). NDJSON control on a private dup
of fd 0, frames on a private dup of fd 1, tool returns on fd 3, crash noise
on raw stderr. See packages/extras/code-mode/protocol.ts for the contract.

Invariants:
- one JSON object per line, frames never torn (writer lock)
- exactly one `done`, always last
- the runner arms NO timers — the host is the only clock
- persistent user_ns; SIGINT at idle is ignored, mid-cell raises
"""
import ast
import asyncio
import concurrent.futures
import contextvars
import importlib
import inspect
import io
import json
import linecache
import os
import signal
import sys
import threading
import time
import traceback

PROTOCOL = 1
_CHUNK = 8192

# ---- streams: dup BEFORE repointing ---------------------------------------
# Control reads from a private dup of fd 0; fd 0 itself goes to /dev/null so
# a cell's input() reads EOF instead of stealing protocol frames. Frames go
# to a private dup of fd 1; raw fd 1 is repointed at a capture pipe whose
# drain thread re-emits child output as stdout frames (children can't spoof
# protocol because they only reach the capture pipe).
_CTRL = os.fdopen(os.dup(0), "r", encoding="utf-8")
_fd = os.open(os.devnull, os.O_RDONLY)
os.dup2(_fd, 0)
os.close(_fd)
_FRAME = os.fdopen(os.dup(1), "w", encoding="utf-8", errors="backslashreplace")
_CAP_R, _cap_w = os.pipe()
os.dup2(_cap_w, 1)
os.close(_cap_w)
try:
    _RET = os.fdopen(os.dup(3), "r", encoding="utf-8")
except OSError:
    _RET = None

_WLOCK = threading.Lock()
_SIGS = {signal.SIGINT, signal.SIGTERM} if hasattr(signal, "pthread_sigmask") else set()


class _State:
    def __init__(self):
        self.ns = {"__name__": "__main__", "__builtins__": __builtins__}
        self.pending = {}
        self.seq = 0
        self.budget = 50
        self.cancel = False
        self.shutdown = False
        self.executions = 0
        self.t0 = 0.0
        self.preamble_done = False


_S = _State()
_RID = contextvars.ContextVar("rid", default=None)
_LOOP = asyncio.new_event_loop()
_MISSING = object()
_BOOT_ENV = dict(os.environ)

try:
    import dill as _dill
except ImportError:
    _dill = None


def _emit(obj):
    data = (json.dumps(obj, ensure_ascii=False, default=repr) + "\n").encode()
    old = signal.pthread_sigmask(signal.SIG_BLOCK, _SIGS) if _SIGS else None
    try:
        with _WLOCK:
            _FRAME.buffer.write(data)
            _FRAME.flush()
    except (BrokenPipeError, OSError):
        _S.shutdown = True
    finally:
        if old is not None:
            signal.pthread_sigmask(signal.SIG_SETMASK, old)


class _Stream(io.TextIOBase):
    """Coalescing proxy: newline or 8192 bytes, flushed per request."""

    def __init__(self, kind):
        self.kind = kind
        self.buf = {}

    def write(self, s):
        rid = _RID.get()
        if not s or rid is None:
            return len(s)
        out = self.buf.get(rid, "") + s
        nl = out.rfind("\n")
        if len(out) >= _CHUNK or nl >= 0:
            cut = len(out) if (len(out) >= _CHUNK and nl < 0) else nl + 1
            _emit({"t": self.kind, "id": rid, "data": out[:cut]})
            out = out[cut:]
        self.buf[rid] = out
        return len(s)

    def flush(self):
        rid = _RID.get()
        if rid is not None and self.buf.get(rid):
            _emit({"t": self.kind, "id": rid, "data": self.buf.pop(rid)})
        return None


_OUT = _Stream("stdout")
_ERR = _Stream("stderr")


class ToolError(Exception):
    pass


class _Cancelled(BaseException):
    """Raised by fd-3 cancel. BaseException so `except Exception` can't swallow it."""


# ---- guest tool calls (lazy: frame emitted on await) -----------------------
class _Call:
    def __init__(self, name, args):
        self.name = name
        self.args = args
        self._fut = None

    def _start(self):
        rid = _RID.get()
        if rid is None or _RET is None:
            raise ToolError("tool bridge unavailable")
        if _S.cancel:
            raise _Cancelled("cell cancelled")
        if _S.budget <= 0:
            raise ToolError("budget exhausted for this cell")
        _S.budget -= 1
        _S.seq += 1
        cid = f"c{_S.seq}"
        fut = concurrent.futures.Future()
        _S.pending[cid] = fut
        _emit({"t": "tool-call", "id": rid, "callId": cid, "seq": _S.seq,
               "name": self.name, "args": self.args})
        self._fut = fut
        return fut

    def __await__(self):
        return asyncio.wrap_future(self._start()).__await__()

    @property
    def value(self):
        """Blocking wait (SIGINT-interruptible)."""
        return self._start().result()


class _ToolsNS:
    def __init__(self, names):
        object.__setattr__(self, "_names", set(names))

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        if name == "code":
            raise AttributeError("tools.code is blocked: a cell cannot launch a cell")
        if name not in self._names:
            raise AttributeError(
                f"unknown tool {name!r}. Visible: {', '.join(sorted(self._names))}")
        def call(**kwargs):
            return _Call(name, kwargs)
        return call

    def __call__(self, name, args=None):
        if name not in self._names:
            raise AttributeError(f"unknown tool {name!r}")
        return _Call(name, dict(args or {}))

    @property
    def remaining(self):
        return _S.budget


def _return_loop():
    """Dedicated thread, never raises."""
    for line in _RET:
        try:
            f = json.loads(line)
        except ValueError:
            _emit({"t": "stderr", "id": None,
                   "data": "[kernel] bad return frame\n"})
            continue
        if f.get("t") == "cancel":
            _S.cancel = True
            for fut in list(_S.pending.values()):
                if not fut.done():
                    fut.set_exception(_Cancelled(f.get("reason") or "cancelled"))
            _S.pending.clear()
            continue
        fut = _S.pending.pop(f.get("callId"), None)
        if fut is None:
            continue
        if f.get("budgetLeft") is not None:
            try:
                _S.budget = int(f["budgetLeft"])
            except (TypeError, ValueError):
                pass
        if f.get("ok"):
            fut.set_result(f.get("answer"))
        else:
            msg = f.get("answer") or f.get("errorMessage") or "tool call failed"
            err = ToolError(msg)
            err.code = f.get("errorMessage")
            fut.set_exception(err)


def _drain_fd1():
    """Capture pipe → stdout frames. Children can't spoof protocol."""
    buf = b""
    while True:
        try:
            chunk = os.read(_CAP_R, 65536)
        except OSError:
            return
        if not chunk:
            return
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            rid = _RID.get()
            _emit({"t": "stdout", "id": rid,
                   "data": line.decode("utf-8", "backslashreplace") + "\n"})


# ---- compile: trailing expr split + top-level await -------------------------
_TLA = getattr(ast, "PyCF_ALLOW_TOP_LEVEL_AWAIT", 0x2000)


def _compile(src, filename="<cell>"):
    mod = ast.parse(src, filename, "exec")
    if not mod.body:
        return None, None, False
    tail = mod.body[-1]
    if isinstance(tail, ast.Expr):
        body = ast.Module(body=mod.body[:-1], type_ignores=[])
        expr = ast.Expression(body=tail.value)
        ast.copy_location(expr, tail)
        ast.fix_missing_locations(body)
        return (compile(body, filename, "exec", flags=_TLA),
                compile(expr, filename, "eval", flags=_TLA), True)
    return compile(mod, filename, "exec", flags=_TLA), None, False


async def _run_code(code, want):
    if code.co_flags & inspect.CO_COROUTINE:
        v = await eval(code, _S.ns)
        return v if want else None
    if want:
        return eval(code, _S.ns)
    exec(code, _S.ns)
    return None


async def _run_source(src, filename="<cell>"):
    body, expr, has = _compile(src, filename)
    if body is None:
        return _MISSING
    await _run_code(body, False)
    return (await _run_code(expr, True)) if has else _MISSING


def _err(e):
    tb = []
    for fr in traceback.extract_tb(e.__traceback__):
        if fr.filename == __file__ or "<cell>" not in fr.filename and "cell-" not in (fr.filename or ""):
            # Keep user frames; drop runner frames. "<cell>" frames always stay.
            if fr.filename == __file__:
                continue
        tb.append(f'  File "{fr.filename}", line {fr.lineno}, in {fr.name}\n    {fr.line}')
    return {"ename": type(e).__name__, "evalue": str(e), "traceback": tb[-20:]}


def _echo(value):
    try:
        r = repr(value)
    except Exception as e:
        r = f"<unrepresentable: {e}>"
    truncated = len(r) > 4000
    if truncated:
        r = r[:4000]
    return {"t": "result", "id": _RID.get(), "repr": r,
            "type": type(value).__name__, "truncated": truncated}


# ---- magics: %load (async) and %pip (opt-in, clock-paused) ------------------
def _transform_magics(src):
    """Rewrite standalone %lines. Returns (source, needs_async). A reduced
    line scan: a % line inside a nested string is mis-handled (production
    replacement is OMP's tokenize scanner)."""
    out = []
    needs_async = False
    for line in src.split("\n"):
        s = line.strip()
        if s.startswith("%load ") and line[:len(line) - len(line.lstrip())] == "":
            path = s[6:].strip().strip("\"'")
            out.append(f"await __sl_load({path!r})")
            needs_async = True
        elif s.startswith("%pip ") and line[:len(line) - len(line.lstrip())] == "":
            rest = s[5:].strip()
            out.append(f"await __sl_pip({rest!r})")
            needs_async = True
        elif s.startswith("%") and line[:len(line) - len(line.lstrip())] == "":
            raise SyntaxError(f"unknown magic {s.split()[0]!r} — percent commands are not part of code-mode v1")
        else:
            out.append(line)
    return "\n".join(out), needs_async


async def __sl_load(path):
    if len(path) > 8 * 1024 * 1024:
        raise ToolError("%load path too long")
    with open(path, "r", encoding="utf-8") as f:
        src = f.read()
    if len(src) > 8 * 1024 * 1024:
        raise ToolError("%load file exceeds 8 MiB")
    linecache.cache[path] = (len(src), None, src.splitlines(keepends=True), path)
    return await _run_source(src, filename=path)


async def __sl_pip(spec):
    if os.environ.get("SL_ALLOW_PIP") != "1":
        raise ToolError("%pip is not available: cells cannot install packages. Use the bash tool.")
    import subprocess
    _emit({"t": "status", "id": _RID.get(), "phase": "timeout-pause", "reason": "pip"})
    try:
        proc = await asyncio.to_thread(
            subprocess.run, [sys.executable, "-m", "pip"] + spec.split(),
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, timeout=600)
        _emit({"t": "stderr", "id": _RID.get(), "data": proc.stdout[-8000:]})
        if proc.returncode != 0:
            raise ToolError(f"%pip failed with exit code {proc.returncode}")
        importlib.invalidate_caches()
        return f"pip exit {proc.returncode}"
    finally:
        _emit({"t": "status", "id": _RID.get(), "phase": "timeout-resume", "reason": "pip"})


# ---- per-request runtime reapply --------------------------------------------
def _apply(req):
    cwd = req.get("cwd")
    if cwd:
        os.chdir(cwd)
        if sys.path[0] != cwd:
            sys.path.insert(0, cwd)
    env = req.get("env")
    if isinstance(env, dict):
        for k, v in env.items():
            os.environ[str(k)] = str(v)
    asyncio.set_event_loop(_LOOP)
    _install_signals(_default_int_handler if False else signal.default_int_handler)
    sys.stdout = _OUT
    sys.stderr = _ERR


def _install_signals(handler):
    try:
        signal.signal(signal.SIGINT, handler)
    except (OSError, ValueError, RuntimeError):
        pass
    try:
        signal.signal(signal.SIGTERM, _on_term)
    except (OSError, ValueError, RuntimeError):
        pass


def _on_term(signum, frame):
    _S.shutdown = True
    for fut in list(_S.pending.values()):
        if not fut.done():
            fut.set_exception(_Cancelled("kernel shutdown"))
    raise KeyboardInterrupt


def _handle(req):
    rid = str(req.get("id"))
    tok = _RID.set(rid)
    _S.executions += 1
    _S.t0 = time.monotonic()
    _S.cancel = False
    _S.seq = 0
    _S.budget = int(req.get("budget", 50))
    _emit({"t": "status", "id": rid, "phase": "start"})
    ok, cancelled, err, value = True, False, None, _MISSING
    try:
        _apply(req)
        tools = req.get("tools", [])
        _S.ns["tools"] = _ToolsNS(tools if isinstance(tools, list) else [])
        _S.ns["ToolError"] = ToolError
        _S.ns["__sl_load"] = __sl_load
        _S.ns["__sl_pip"] = __sl_pip
        src = req.get("code", "")
        try:
            src, _ = _transform_magics(src)
        except SyntaxError as e:
            ok, err = False, _err(e)
        else:
            value = _LOOP.run_until_complete(
                _run_source(src, req.get("filename") or "<cell>"))
    except KeyboardInterrupt:
        cancelled, ok, err = True, False, _err(KeyboardInterrupt("cell interrupted"))
        _OUT.flush()
        _ERR.flush()
    except _Cancelled as e:
        cancelled, ok, err = True, False, _err(e)
        _OUT.flush()
        _ERR.flush()
    except BaseException as e:
        ok, err = False, _err(e)
    finally:
        try:
            _OUT.flush()
            _ERR.flush()
            if value is not _MISSING and value is not None:
                _emit(_echo(value))
            wall = int((time.monotonic() - _S.t0) * 1000)
            _emit({"t": "done", "id": rid, "ok": ok, "cancelled": cancelled,
                   "timed_out": False, "error": err,
                   "exec_ms": wall, "wall_ms": wall,
                   "executions": _S.executions, "budget_left": _S.budget})
        finally:
            _install_signals(signal.SIG_IGN)
            _RID.reset(tok)
    _persist()


# ---- persistence (opt-in dill sidecar, never taped) --------------------------
def _sidecar():
    d = os.environ.get("SL_PERSIST_DIR")
    if not d:
        return None
    kid = os.environ.get("SL_KERNEL_ID", "py")
    return os.path.join(d, f"kernel-{kid}.dill")


def _persist(force=False):
    path = _sidecar()
    if path is None or _dill is None:
        return
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(b"SLK1\n")
            f.write(sys.version.split()[0].encode() + b"\n")
            clean = {k: v for k, v in _S.ns.items()
                     if k not in ("__builtins__", "tools", "ToolError",
                                  "__sl_load", "__sl_pip")}
            _dill.dump(clean, f)
        os.replace(tmp, path)
    except Exception as e:
        _emit({"t": "stderr", "id": None,
               "data": f"[kernel] persist failed: {e}\n"})


def _load_persist():
    path = _sidecar()
    if path is None or _dill is None or not os.path.exists(path):
        return False
    try:
        with open(path, "rb") as f:
            if f.readline() != b"SLK1\n":
                return False
            interp = f.readline().decode().strip()
            if not sys.version.startswith(interp.split(".")[0]):
                return False
            clean = _dill.load(f)
        if isinstance(clean, dict):
            _S.ns.update(clean)
        return True
    except Exception as e:
        _emit({"t": "stderr", "id": None,
               "data": f"[kernel] restore failed ({e}); starting fresh\n"})
        return False


def _watchdog():
    if os.name != "posix":
        return
    ppid = os.getppid()
    while True:
        if os.getppid() != ppid:
            _persist(force=True)
            os._exit(0)
        time.sleep(10)


def main():
    asyncio.set_event_loop(_LOOP)
    _install_signals(signal.SIG_IGN)
    sys.stdout = _OUT
    sys.stderr = _ERR
    threading.Thread(target=_watchdog, daemon=True).start()
    threading.Thread(target=_drain_fd1, daemon=True).start()
    if _RET is not None:
        threading.Thread(target=_return_loop, daemon=True).start()
    loaded = _load_persist()
    _emit({"t": "status", "id": None, "phase": "ready", "protocol": PROTOCOL,
           "runtime": sys.version.split()[0], "pid": os.getpid(),
           "persist": _sidecar() is not None, "loaded": loaded,
           "dill": _dill is not None})
    while not _S.shutdown:
        try:
            line = _CTRL.readline()
        except KeyboardInterrupt:
            continue
        if not line:
            break
        try:
            req = json.loads(line)
        except ValueError:
            _emit({"t": "stderr", "id": None,
                   "data": "[kernel] bad control line\n"})
            continue
        if req.get("t") == "shutdown":
            break
        if req.get("t") == "exec":
            _handle(req)
    _persist(force=True)
    os._exit(0)


if __name__ == "__main__":
    main()
