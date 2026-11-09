"""Own a launched process tree; never accept an existing PID to terminate.

Windows: suspend before Job assignment, then resume. Kill-on-close prevents a
normal parent exit from releasing uncontrolled descendants. This is lifecycle
ownership, not a filesystem/credential security boundary.
"""
import ctypes
import os
import signal
import subprocess
import time


if os.name == 'nt':
    from ctypes import wintypes as w

    class _BasicLimit(ctypes.Structure):
        _fields_ = [('PerProcessUserTimeLimit', ctypes.c_longlong), ('PerJobUserTimeLimit', ctypes.c_longlong),
                    ('LimitFlags', w.DWORD), ('MinimumWorkingSetSize', ctypes.c_size_t),
                    ('MaximumWorkingSetSize', ctypes.c_size_t), ('ActiveProcessLimit', w.DWORD),
                    ('Affinity', ctypes.c_size_t), ('PriorityClass', w.DWORD), ('SchedulingClass', w.DWORD)]

    class _IOCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in
                    ('ReadOperationCount', 'WriteOperationCount', 'OtherOperationCount',
                     'ReadTransferCount', 'WriteTransferCount', 'OtherTransferCount')]

    class _ExtendedLimit(ctypes.Structure):
        _fields_ = [('BasicLimitInformation', _BasicLimit), ('IoInfo', _IOCounters),
                    ('ProcessMemoryLimit', ctypes.c_size_t), ('JobMemoryLimit', ctypes.c_size_t),
                    ('PeakProcessMemoryUsed', ctypes.c_size_t), ('PeakJobMemoryUsed', ctypes.c_size_t)]

    class _Accounting(ctypes.Structure):
        _fields_ = [(name, ctypes.c_longlong) for name in
                    ('TotalUserTime', 'TotalKernelTime', 'ThisPeriodTotalUserTime', 'ThisPeriodTotalKernelTime')] + [
                    (name, w.DWORD) for name in
                    ('TotalPageFaultCount', 'TotalProcesses', 'ActiveProcesses', 'TotalTerminatedProcesses')]

    _kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    _kernel.CreateJobObjectW.argtypes = (ctypes.c_void_p, w.LPCWSTR)
    _kernel.CreateJobObjectW.restype = w.HANDLE
    _kernel.SetInformationJobObject.argtypes = (w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD)
    _kernel.SetInformationJobObject.restype = w.BOOL
    _kernel.AssignProcessToJobObject.argtypes = (w.HANDLE, w.HANDLE)
    _kernel.AssignProcessToJobObject.restype = w.BOOL
    _kernel.QueryInformationJobObject.argtypes = (w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.c_void_p)
    _kernel.QueryInformationJobObject.restype = w.BOOL
    _kernel.TerminateJobObject.argtypes = (w.HANDLE, w.UINT)
    _kernel.TerminateJobObject.restype = w.BOOL
    _kernel.CloseHandle.argtypes = (w.HANDLE,)
    _kernel.CloseHandle.restype = w.BOOL
    _nt = ctypes.WinDLL('ntdll')
    _nt.NtResumeProcess.argtypes = (w.HANDLE,)
    _nt.NtResumeProcess.restype = ctypes.c_long


class OwnedProcess:
    """Popen-compatible subset, plus verified tree termination/cleanup.

    ``wait`` waits for the direct parent. ``close`` must subsequently be called
    and return True before releasing write reservations. No arbitrary PID input
    or global process enumeration is used. ``terminate_tree`` is idempotent.
    """
    def __init__(self, argv, **kwargs):
        if kwargs.get('shell'):
            raise ValueError('owned launch requires shell=False')
        self._job = None
        self._closed = False
        self._process = None
        self._tree_confirmed = False
        if os.name == 'nt':
            self._job = _kernel.CreateJobObjectW(None, None)
            if not self._job:
                raise ctypes.WinError(ctypes.get_last_error())
            try:
                limit = _ExtendedLimit()
                limit.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                if not _kernel.SetInformationJobObject(self._job, 9, ctypes.byref(limit), ctypes.sizeof(limit)):
                    raise ctypes.WinError(ctypes.get_last_error())
                flags = kwargs.pop('creationflags', 0)
                # Disallow job breakaway; never execute prior to assignment.
                if flags & 0x01000000:
                    raise ValueError('job breakaway is forbidden')
                kwargs['creationflags'] = flags | 0x00000004 | 0x08000000  # SUSPENDED | NO_WINDOW
                self._process = subprocess.Popen(argv, **kwargs)
                if not _kernel.AssignProcessToJobObject(self._job, int(self._process._handle)):
                    raise ctypes.WinError(ctypes.get_last_error())
                if _nt.NtResumeProcess(int(self._process._handle)) < 0:
                    raise OSError('NtResumeProcess failed before execution')
            except BaseException:
                try:
                    if self._process is not None:
                        self._process.kill()  # Only our own launch, before successful resume.
                        self._process.wait(timeout=5)
                        self._close_streams()
                        self._process._handle.Close()
                finally:
                    _kernel.CloseHandle(self._job)
                    self._job = None
                raise
        else:
            kwargs.pop('creationflags', None)
            kwargs['start_new_session'] = True
            self._process = subprocess.Popen(argv, **kwargs)

    @property
    def pid(self):
        return self._process.pid

    @property
    def stdin(self):
        return self._process.stdin

    @property
    def stdout(self):
        return self._process.stdout

    @property
    def stderr(self):
        return self._process.stderr

    @property
    def returncode(self):
        return self._process.returncode

    def poll(self):
        return self._process.poll()

    def wait(self, timeout=None):
        return self._process.wait(timeout=timeout)

    def communicate(self, *args, **kwargs):
        return self._process.communicate(*args, **kwargs)

    def active_processes(self):
        if self._closed:
            return 0 if self._tree_confirmed else None
        if os.name == 'nt':
            info = _Accounting()
            if not _kernel.QueryInformationJobObject(self._job, 1, ctypes.byref(info), ctypes.sizeof(info), None):
                return None
            return int(info.ActiveProcesses)
        try:
            os.killpg(self.pid, 0)
            return 1  # Existence only, not a count on Unix.
        except ProcessLookupError:
            return 0
        except PermissionError:
            return None

    def terminate_tree(self, timeout=5):
        if self._closed:
            return self._tree_confirmed
        try:
            count = self.active_processes()
            if count != 0:
                if os.name == 'nt':
                    if not _kernel.TerminateJobObject(self._job, 1):
                        return False
                else:
                    try:
                        os.killpg(self.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                self.poll()  # Reap our direct child where supported.
                if self.active_processes() == 0:
                    # Job accounting can reach zero just before the process
                    # handle becomes signalled; reap before reporting cleanup.
                    self._process.wait(timeout=max(.1, deadline - time.monotonic()))
                    self._tree_confirmed = True
                    return True
                time.sleep(.01)
            return False
        except (OSError, subprocess.SubprocessError):
            return False

    # Existing cancellation call sites can use these, but must still check the
    # boolean return or call close before releasing resources.
    def terminate(self):
        return self.terminate_tree()

    def kill(self):
        return self.terminate_tree()

    def _close_streams(self):
        for stream in (self._process.stdin, self._process.stdout, self._process.stderr):
            if stream is not None and not stream.closed:
                stream.close()

    def close(self, timeout=5):
        if self._closed:
            return self._tree_confirmed
        confirmed = self.terminate_tree(timeout)
        # Kill-on-close still contains descendants if verification failed; the
        # caller must retain unknown resources because close is not proof.
        if os.name == 'nt' and self._job:
            _kernel.CloseHandle(self._job)
            self._job = None
        self._closed = True
        self._tree_confirmed = confirmed
        self._close_streams()
        if os.name == 'nt' and self._process.returncode is not None:
            self._process._handle.Close()
        return confirmed

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
