param([string]$NodePath, [string]$ChildScript, [string]$Witness)
$ErrorActionPreference = 'Stop'
# P/Invoke limité au Job Object et aux processus de cette sonde. Aucun réglage système.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.ComponentModel;
public class ArchipelJobProbe {
  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr MinWorking, MaxWorking; public uint ActiveProcesses;
    public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong A,B,C,D,E,F; }
  [StructLayout(LayoutKind.Sequential)] struct Extended {
    public Basic Basic; public Io Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public uint cb; public string reserved, desktop, title;
    public uint x,y,xsize,ysize,xchars,ychars,fill,flags;
    public ushort show,reserved2; public IntPtr reservedPtr,stdin,stdout,stderr;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr process,thread; public uint pid,tid;
  }
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref Extended limits,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Extended limits,uint size,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out ProcessInfo info);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint exit);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle,out uint exit);
  static void Check(bool ok) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static void Run(string node,string script,string witness) {
    IntPtr job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
    ProcessInfo p=new ProcessInfo(), second=new ProcessInfo(), third=new ProcessInfo();
    try {
      Extended limits=new Extended(); limits.Basic.Flags=0x2000|0x8|0x200;
      limits.Basic.ActiveProcesses=2; limits.JobMemory=(UIntPtr)(1024UL*1024*1024);
      uint size=(uint)Marshal.SizeOf(typeof(Extended));
      Check(SetInformationJobObject(job,9,ref limits,size));
      Extended observed; Check(QueryInformationJobObject(job,9,out observed,size,IntPtr.Zero));
      Console.WriteLine("JOB_LIMITS {\"flags\":"+observed.Basic.Flags+",\"activeProcesses\":"+observed.Basic.ActiveProcesses+",\"jobMemory\":"+observed.JobMemory.ToUInt64()+"}");
      Startup si=new Startup();si.cb=(uint)Marshal.SizeOf(typeof(Startup));
      Check(CreateProcess(node,new StringBuilder("\""+node+"\" \""+script+"\""),IntPtr.Zero,IntPtr.Zero,false,0x4|0x08000000,IntPtr.Zero,Path.GetDirectoryName(script),ref si,out p));
      Check(AssignProcessToJobObject(job,p.process)); Check(ResumeThread(p.thread)!=0xffffffff);
      for(int i=0;i<100 && !File.Exists(witness);i++) System.Threading.Thread.Sleep(50);
      if(!File.Exists(witness)) { uint exit;GetExitCodeProcess(p.process,out exit);throw new Exception("Aucun témoin ; exit="+exit+"; status="+(File.Exists(witness+".status")?File.ReadAllText(witness+".status"):"absent")); }
      Check(CreateProcess(node,new StringBuilder("\""+node+"\" \""+script+"\""),IntPtr.Zero,IntPtr.Zero,false,0x4|0x08000000,IntPtr.Zero,Path.GetDirectoryName(script),ref si,out second));
      Check(AssignProcessToJobObject(job,second.process));Check(ResumeThread(second.thread)!=0xffffffff);
      Check(CreateProcess(node,new StringBuilder("\""+node+"\" \""+script+"\""),IntPtr.Zero,IntPtr.Zero,false,0x4|0x08000000,IntPtr.Zero,Path.GetDirectoryName(script),ref si,out third));
      bool thirdAssigned=AssignProcessToJobObject(job,third.process);int thirdError=Marshal.GetLastWin32Error();
      TerminateProcess(third.process,1);
      if(thirdAssigned) throw new Exception("La limite de deux processus est contournée");
      if(WaitForSingleObject(p.process,0)!=258 || WaitForSingleObject(second.process,0)!=258) throw new Exception("Les témoins ne sont pas actifs avant fermeture");
      Console.WriteLine("JOB_WITNESS {\"first\":"+p.pid+",\"second\":"+second.pid+",\"thirdError\":"+thirdError+"}");
      Check(CloseHandle(job));job=IntPtr.Zero;
      if(WaitForSingleObject(p.process,5000)!=0) throw new Exception("Le parent reste actif après fermeture du job");
      if(WaitForSingleObject(second.process,5000)!=0) throw new Exception("Le second processus reste actif après fermeture du job");
    } finally {
      if(job!=IntPtr.Zero) CloseHandle(job);
      if(p.process!=IntPtr.Zero) { TerminateProcess(p.process,1);CloseHandle(p.process); }
      if(p.thread!=IntPtr.Zero) CloseHandle(p.thread);
      if(second.process!=IntPtr.Zero) { TerminateProcess(second.process,1);CloseHandle(second.process); }
      if(second.thread!=IntPtr.Zero) CloseHandle(second.thread);
      if(third.process!=IntPtr.Zero) { TerminateProcess(third.process,1);CloseHandle(third.process); }
      if(third.thread!=IntPtr.Zero) CloseHandle(third.thread);
    }
  }
}
'@
[ArchipelJobProbe]::Run($NodePath, $ChildScript, $Witness)
