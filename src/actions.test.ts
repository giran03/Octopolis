import { describe, expect, it } from "vitest";
import { ADMIN_RUNNABLE, INSTALLABLE, RUNNABLE, TEXT_FILE } from "./actions";

describe("file action classification", () => {
  it("does not redirect batch scripts to the text editor on double-click", () => {
    expect(TEXT_FILE.test("build.bat")).toBe(false);
    expect(TEXT_FILE.test("deploy.CMD")).toBe(false);
    expect(TEXT_FILE.test("installer.msi")).toBe(false);
    expect(TEXT_FILE.test("font.ttf")).toBe(false);
    expect(TEXT_FILE.test("notes.txt")).toBe(true);
    expect(TEXT_FILE.test("README.md")).toBe(true);
    expect(TEXT_FILE.test("index.ts")).toBe(true);
  });

  it("identifies runnable executables and scripts", () => {
    for (const name of ["app.exe", "setup.com", "run.bat", "run.CMD", "script.ps1", "task.vbs", "ui.hta", "saver.scr", "diskmgmt.msc", "appwiz.cpl"]) {
      expect(RUNNABLE.test(name), name).toBe(true);
    }
    for (const name of ["notes.txt", "font.ttf", "setup.msi", "archive.zip"]) {
      expect(RUNNABLE.test(name), name).toBe(false);
    }
  });

  it("identifies installable fonts, packages, setup scripts and registry files", () => {
    for (const name of ["Inter.ttf", "JetBrains.OTF", "Cambria.ttc", "vgafix.fon", "driver.inf", "setup.msi", "app.msix", "pkg.appx", "tweak.reg", "root.cer", "cert.crt"]) {
      expect(INSTALLABLE.test(name), name).toBe(true);
    }
    for (const name of ["app.exe", "run.bat", "notes.txt"]) {
      expect(INSTALLABLE.test(name), name).toBe(false);
    }
  });

  it("identifies files that can run as administrator", () => {
    for (const name of ["app.exe", "run.bat", "run.cmd", "setup.msi", "script.ps1", "tool.com"]) {
      expect(ADMIN_RUNNABLE.test(name), name).toBe(true);
    }
    expect(ADMIN_RUNNABLE.test("font.ttf")).toBe(false);
  });
});
