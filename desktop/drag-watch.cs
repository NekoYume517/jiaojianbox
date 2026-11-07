using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows.Forms;

// Out-of-context accessibility hook. No Explorer injection and no file-content reads.
class DragWatch {
 delegate void WinEventProc(IntPtr hook,uint evt,IntPtr hwnd,int objectId,int childId,uint thread,uint time);
 [DllImport("user32.dll")]static extern IntPtr SetWinEventHook(uint min,uint max,IntPtr module,WinEventProc proc,uint process,uint thread,uint flags);
 [DllImport("user32.dll")]static extern bool UnhookWinEvent(IntPtr hook);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr hwnd,StringBuilder text,int max);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern IntPtr FindWindow(string cls,string name);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll")]static extern short GetAsyncKeyState(int key);
 static readonly WinEventProc callback=OnEvent;
 static readonly HashSet<IntPtr> images=new HashSet<IntPtr>();
 static bool dragging;
 static bool Held(){return (GetAsyncKeyState(1)&0x8000)!=0||(GetAsyncKeyState(2)&0x8000)!=0;}
 static void Emit(bool active){if(active==dragging)return;dragging=active;Console.WriteLine(active?"drag":"release");Console.Out.Flush();}
 static bool IsDragImage(IntPtr hwnd){if(hwnd==IntPtr.Zero)return false;var cls=new StringBuilder(128);GetClassName(hwnd,cls,cls.Capacity);return cls.ToString()=="SysDragImage";}
 static void OnEvent(IntPtr hook,uint evt,IntPtr hwnd,int objectId,int childId,uint thread,uint time){
  if(hwnd==IntPtr.Zero||objectId!=0||childId!=0)return;
  if(evt==0x8001||evt==0x8003){if(images.Remove(hwnd)&&!Held())Emit(false);return;}
  if((evt==0x8000||evt==0x8002)&&IsDragImage(hwnd)){images.Add(hwnd);if(Held())Emit(true);}
 }
 [STAThread]static void Main(){
  IntPtr hook=SetWinEventHook(0x8000,0x8003,IntPtr.Zero,callback,0,0,2); // OUTOFCONTEXT | SKIPOWNPROCESS
  if(hook==IntPtr.Zero){Console.Error.WriteLine("WinEvent hook unavailable");Environment.Exit(1);}
  var timer=new Timer();timer.Interval=32;
  timer.Tick+=(sender,args)=>{
   if((GetAsyncKeyState(27)&0x8000)!=0||!Held()){Emit(false);return;}
   if(!dragging){var image=FindWindow("SysDragImage",null);if(image!=IntPtr.Zero&&IsWindowVisible(image)){images.Add(image);Emit(true);}}
  };
  timer.Start();Application.ApplicationExit+=(s,e)=>{timer.Stop();UnhookWinEvent(hook);};Application.Run();GC.KeepAlive(callback);
 }
}
