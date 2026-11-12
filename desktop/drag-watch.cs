using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

// Out-of-context, Explorer-scoped WinEvent listener. It never injects into Explorer
// and never reads the dragged files or their contents.
class DragWatch {
	const uint EVENT_SYSTEM_DRAGDROPSTART = 0x000E;
	const uint EVENT_SYSTEM_DRAGDROPEND = 0x000F;
	const uint EVENT_OBJECT_DESTROY = 0x8001;
	const uint EVENT_OBJECT_SHOW = 0x8002;
	const uint EVENT_OBJECT_HIDE = 0x8003;
	const uint EVENT_OBJECT_DRAGSTART = 0x8021;
	const uint EVENT_OBJECT_DRAGCANCEL = 0x8022;
	const uint EVENT_OBJECT_DRAGCOMPLETE = 0x8023;
	const uint WINEVENT_OUTOFCONTEXT = 0x0000;
	const uint WINEVENT_SKIPOWNPROCESS = 0x0002;
	const int VK_LBUTTON = 0x01;
	const int VK_RBUTTON = 0x02;
	const int VK_ESCAPE = 0x1B;

	delegate void WinEventProc(IntPtr hook, uint evt, IntPtr hwnd, int objectId, int childId, uint thread, uint time);
	delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr state);

	[DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc proc, uint process, uint thread, uint flags);
	[DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
	[DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
	[DllImport("user32.dll")] static extern IntPtr GetShellWindow();
	[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
	[DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc proc, IntPtr state);
	[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
	[DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);

	static readonly WinEventProc callback = OnEvent;
	static readonly object stateLock = new object();
	static IntPtr[] hooks = new IntPtr[0];
	static uint[] hookedProcesses = new uint[0];
	static uint[] hookedThreads = new uint[0];
	static IntPtr dragImage;
	static bool dragging;
	static Timer dragTimer;
	static Timer parentTimer;
	static Timer hookTimer;

	static bool Held() {
		return (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0 ||
			(GetAsyncKeyState(VK_RBUTTON) & 0x8000) != 0;
	}

	static bool IsDragImage(IntPtr hwnd) {
		if (hwnd == IntPtr.Zero) return false;
		var className = new StringBuilder(128);
		GetClassName(hwnd, className, className.Capacity);
		return className.ToString() == "SysDragImage";
	}

	static void WriteState(bool active) {
		lock (stateLock) {
			if (active == dragging) return;
			dragging = active;
			Console.WriteLine(active ? "drag" : "release");
			Console.Out.Flush();
		}
		Timer timer = dragTimer;
		if (timer != null) {
			if (active) timer.Start();
			else timer.Stop();
		}
	}

	static void StartDrag(IntPtr hwnd) {
		if (hwnd != IntPtr.Zero && IsDragImage(hwnd)) {
			lock (stateLock) dragImage = hwnd;
		}
		WriteState(true);
	}

	static void EndDrag(IntPtr hwnd) {
		lock (stateLock) {
			if (hwnd != IntPtr.Zero && dragImage != IntPtr.Zero && hwnd != dragImage) return;
			dragImage = IntPtr.Zero;
		}
		WriteState(false);
	}

	static void OnEvent(IntPtr hook, uint evt, IntPtr hwnd, int objectId, int childId, uint thread, uint time) {
		switch (evt) {
			case EVENT_SYSTEM_DRAGDROPSTART:
			case EVENT_OBJECT_DRAGSTART:
				StartDrag(IntPtr.Zero);
				break;
			case EVENT_SYSTEM_DRAGDROPEND:
			case EVENT_OBJECT_DRAGCANCEL:
			case EVENT_OBJECT_DRAGCOMPLETE:
				EndDrag(IntPtr.Zero);
				break;
			case EVENT_OBJECT_SHOW:
				// Windows Explorer's system drag bitmap is an implementation detail,
				// so it is only a fallback for shell versions that do not emit the
				// documented object-level drag events above.
				if (IsDragImage(hwnd)) StartDrag(hwnd);
				break;
			case EVENT_OBJECT_HIDE:
			case EVENT_OBJECT_DESTROY:
				if (IsDragImage(hwnd)) EndDrag(hwnd);
				break;
		}
	}

	static void RemoveHooks() {
		var current = hooks;
		hooks = new IntPtr[0];
		foreach (var hook in current) {
			if (hook != IntPtr.Zero) UnhookWinEvent(hook);
		}
	}

	static void AddHook(uint eventId, uint processId, uint threadId) {
		var hook = SetWinEventHook(
			eventId,
			eventId,
			IntPtr.Zero,
			callback,
			processId,
			threadId,
			WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS
		);
		if (hook == IntPtr.Zero) throw new InvalidOperationException("WinEvent hook unavailable: " + eventId);
		Array.Resize(ref hooks, hooks.Length + 1);
		hooks[hooks.Length - 1] = hook;
	}

	static uint[] ExplorerProcesses() {
		var ids = new uint[0];
		foreach (var process in Process.GetProcessesByName("explorer")) {
			try {
				Array.Resize(ref ids, ids.Length + 1);
				ids[ids.Length - 1] = (uint)process.Id;
			} finally {
				process.Dispose();
			}
		}
		if (ids.Length == 0) {
			// GetShellWindow is a reliable final fallback if process enumeration
			// races with an Explorer restart.
			var shellWindow = GetShellWindow();
			uint processId = 0;
			if (shellWindow != IntPtr.Zero) GetWindowThreadProcessId(shellWindow, out processId);
			if (processId != 0) ids = new uint[] { processId };
		}
		Array.Sort(ids);
		return ids;
	}

	static uint[] ExplorerThreads(uint[] processIds) {
		var threadIds = new uint[0];
		EnumWindows(delegate(IntPtr hwnd, IntPtr state) {
			uint processId = 0;
			var threadId = GetWindowThreadProcessId(hwnd, out processId);
			if (threadId != 0 && Array.IndexOf(processIds, processId) >= 0 && Array.IndexOf(threadIds, threadId) < 0) {
				Array.Resize(ref threadIds, threadIds.Length + 1);
				threadIds[threadIds.Length - 1] = threadId;
			}
			return true;
		}, IntPtr.Zero);
		Array.Sort(threadIds);
		return threadIds;
	}

	static bool SameIds(uint[] left, uint[] right) {
		if (left.Length != right.Length) return false;
		for (int i = 0; i < left.Length; i++) {
			if (left[i] != right[i]) return false;
		}
		return true;
	}

	static void EnsureExplorerHooks() {
		var processIds = ExplorerProcesses();
		if (processIds.Length == 0) throw new InvalidOperationException("Windows Explorer is unavailable");
		var threadIds = ExplorerThreads(processIds);
		if (SameIds(processIds, hookedProcesses) && SameIds(threadIds, hookedThreads) && hooks.Length > 0) return;

		EndDrag(IntPtr.Zero);
		RemoveHooks();
		hookedProcesses = processIds;
		hookedThreads = threadIds;

		foreach (var processId in processIds) {
			// Documented WinEvent drag lifecycle. Explorer and modern shell drag
			// providers emit these without us touching their process.
			AddHook(EVENT_SYSTEM_DRAGDROPSTART, processId, 0);
			AddHook(EVENT_SYSTEM_DRAGDROPEND, processId, 0);
			AddHook(EVENT_OBJECT_DRAGSTART, processId, 0);
			AddHook(EVENT_OBJECT_DRAGCANCEL, processId, 0);
			AddHook(EVENT_OBJECT_DRAGCOMPLETE, processId, 0);
		}
		foreach (var threadId in threadIds) {
			// Compatibility fallback for Explorer versions that do not emit the
			// lifecycle above. Window events are thread-scoped so taskbar, focus,
			// selection and unrelated shell objects do not reach the callback.
			AddHook(EVENT_OBJECT_SHOW, 0, threadId);
			AddHook(EVENT_OBJECT_HIDE, 0, threadId);
			AddHook(EVENT_OBJECT_DESTROY, 0, threadId);
		}
	}

	[STAThread]
	static void Main(string[] args) {
		Process parent = null;
		int parentId;
		if (args.Length == 2 && args[0] == "--parent-pid" && int.TryParse(args[1], out parentId)) {
			try {
				parent = Process.GetProcessById(parentId);
				if (parent.HasExited) return;
			} catch {
				return;
			}
		}

		EnsureExplorerHooks();

		// Only runs while a drag is active. It is a one-shot safety net for
		// Explorer builds that fail to emit DRAGDROPEND or fail to destroy the
		// drag image after cancellation.
		dragTimer = new Timer();
		dragTimer.Interval = 250;
		dragTimer.Tick += (sender, eventArgs) => {
			bool escape = (GetAsyncKeyState(VK_ESCAPE) & 0x8000) != 0;
			bool imageGone;
			lock (stateLock) imageGone = dragImage != IntPtr.Zero && !IsWindowVisible(dragImage);
			if (escape || !Held() || imageGone) EndDrag(IntPtr.Zero);
		};

		// Keep parent-liveness checks frequent, but do not enumerate Explorer's
		// process and window-thread sets on the same cadence. That enumeration
		// wakes PID and window APIs and is the only meaningful idle cost left.
		parentTimer = new Timer();
		parentTimer.Interval = 2000;
		parentTimer.Tick += (sender, eventArgs) => {
			if (parent != null) {
				try {
					if (parent.HasExited) {
						Application.Exit();
						return;
					}
				} catch {
					Application.Exit();
					return;
				}
			}
		};
		parentTimer.Start();

		// Explorer can restart independently of this process. A 30-second
		// reconciliation keeps restart recovery while leaving ordinary idle
		// periods effectively free.
		hookTimer = new Timer();
		hookTimer.Interval = 30000;
		hookTimer.Tick += (sender, eventArgs) => {
			try {
				EnsureExplorerHooks();
			} catch {
				EndDrag(IntPtr.Zero);
				RemoveHooks();
			}
		};
		hookTimer.Start();

		Application.ApplicationExit += (sender, eventArgs) => {
			if (dragTimer != null) dragTimer.Stop();
			if (parentTimer != null) parentTimer.Stop();
			if (hookTimer != null) hookTimer.Stop();
			RemoveHooks();
		};
		Application.Run();
		GC.KeepAlive(callback);
	}
}
