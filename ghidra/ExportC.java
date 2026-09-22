import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import ghidra.program.model.address.*;
import java.io.*;
import java.nio.file.*;
public class ExportC extends GhidraScript {
  public void run() throws Exception {
    String base = "/home/claude/re/gh/";
    for (String line : Files.readAllLines(Paths.get(base + "labels.txt"))) {
      String[] p = line.trim().split(" ");
      if (p.length < 2) continue;
      Address a = toAddr(Long.parseLong(p[0], 16));
      try { createLabel(a, p[1], true, SourceType.USER_DEFINED); } catch (Exception e) {}
    }
    DecompInterface d = new DecompInterface();
    d.openProgram(currentProgram);
    PrintWriter out = new PrintWriter(new FileWriter(base + "mnms.c"));
    PrintWriter idx = new PrintWriter(new FileWriter(base + "funcs.txt"));
    FunctionIterator it = currentProgram.getFunctionManager().getFunctions(true);
    int n = 0;
    while (it.hasNext()) {
      Function f = it.next();
      if (f.isThunk() || f.isExternal()) continue;
      DecompileResults r = d.decompileFunction(f, 120, monitor);
      idx.println(f.getEntryPoint() + " " + f.getName() + " " + f.getBody().getNumAddresses());
      out.println("// ===== " + f.getName() + " @ " + f.getEntryPoint() + " size " + f.getBody().getNumAddresses());
      if (r != null && r.decompileCompleted()) out.println(r.getDecompiledFunction().getC());
      else out.println("// decompile failed");
      n++;
    }
    out.close(); idx.close();
    println("exported " + n + " functions");
  }
}
