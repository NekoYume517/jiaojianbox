param([Parameter(Mandatory = $true)][int]$AppPid)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class JjbChromeProbe {
    public delegate bool EnumCallback(IntPtr hwnd, IntPtr arg);
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumCallback callback, IntPtr arg);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")]
    public static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out uint value, int size);
    public static IntPtr Find(uint processId) {
        IntPtr result = IntPtr.Zero;
        EnumWindows((hwnd,arg) => {
            uint owner; GetWindowThreadProcessId(hwnd, out owner);
            if(owner == processId && (GetWindowLongPtr(hwnd,-16).ToInt64() & 0x00C00000) == 0x00C00000) {
                result = hwnd; return false;
            }
            return true;
        },IntPtr.Zero);
        return result;
    }
}
'@
$handle = [JjbChromeProbe]::Find($AppPid)
if ($handle -eq [IntPtr]::Zero) { throw 'Native application window not found' }
$style = [JjbChromeProbe]::GetWindowLongPtr($handle, -16).ToInt64()
$dark = [uint32]0
$colour = [uint32]0
$darkResult = [JjbChromeProbe]::DwmGetWindowAttribute($handle, 20, [ref]$dark, 4)
$colourResult = [JjbChromeProbe]::DwmGetWindowAttribute($handle, 35, [ref]$colour, 4)
@{
    caption = (($style -band 0x00C00000) -eq 0x00C00000)
    minimize = (($style -band 0x00020000) -ne 0)
    maximize = (($style -band 0x00010000) -ne 0)
    resize = (($style -band 0x00040000) -ne 0)
    darkSupported = ($darkResult -eq 0)
    dark = $dark
    colourSupported = ($colourResult -eq 0)
    colour = $colour
} | ConvertTo-Json -Compress
