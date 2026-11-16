package com.azdezhishi.mathapp;

import android.content.Context;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.zip.GZIPInputStream;

import org.apache.commons.compress.archivers.tar.TarArchiveEntry;
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream;

/**
 * LocalBackend：在 APK 内用 proot 起一个 Ubuntu rootfs 里的 python3 server.py（127.0.0.1:8117）。
 * 引擎包（rootfs.tar.gz）需先导入：installPack({ path }) 或首次启动时从 Download 目录自动找。
 */
@CapacitorPlugin(name = "LocalBackend")
public class LocalBackendPlugin extends Plugin {

    private static final int PORT = 8117;
    private static final String ROOTFS = "rootfs";
    private static final String MARK = ".installed";

    private Process proc;
    private volatile boolean starting = false;

    private File dir() { return new File(getContext().getFilesDir(), ROOTFS); }

    private File rootfsReady() {
        File d = dir();
        if (new File(d, "bin/sh").exists() && new File(d, MARK).exists()) return d;
        return null;
    }

    /* ---------- JS 接口 ---------- */

    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        File d = rootfsReady();
        r.put("installed", d != null);
        r.put("starting", starting);
        r.put("running", proc != null && proc.isAlive());
        r.put("ready", health(600));
        r.put("port", PORT);
        call.resolve(r);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (health(600)) { JSObject r = ok(true, false); call.resolve(r); return; }
        File d = rootfsReady();
        if (d == null) { call.reject("引擎包未安装：请在设置里导入 rootfs.tar.gz"); return; }
        if (starting) { call.reject("正在启动中"); return; }
        try {
            spawn(d);
        } catch (Exception e) {
            call.reject("启动失败：" + e.getMessage());
            return;
        }
        final PluginCall c = call;
        new Thread(() -> {
            boolean up = false;
            for (int i = 0; i < 60 && !up; i++) {          // 最多等 30s
                try { Thread.sleep(500); } catch (InterruptedException ignored) {}
                up = health(400);
            }
            JSObject r = ok(up, true);
            if (up) c.resolve(r); else c.reject("后端启动超时，点开日志看原因");
        }).start();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (proc != null) { proc.destroy(); proc = null; }
        JSObject r = new JSObject();
        r.put("running", false);
        call.resolve(r);
    }

    /** 日志尾部，排障用 */
    @PluginMethod
    public void log(PluginCall call) {
        JSObject r = new JSObject();
        r.put("text", tail(new File(getContext().getFilesDir(), "backend.log"), 6000));
        call.resolve(r);
    }

    /** 导入引擎包：{ path: "/storage/emulated/0/Download/rootfs.tar.gz" } */
    @PluginMethod
    public void installPack(PluginCall call) {
        String path = call.getString("path");
        if (path == null) { call.reject("缺少 path"); return; }
        File src = new File(path);
        if (!src.exists()) { call.reject("文件不存在：" + path); return; }
        final PluginCall c = call;
        new Thread(() -> {
            try {
                extract(src);
                JSObject r = new JSObject();
                r.put("installed", rootfsReady() != null);
                c.resolve(r);
            } catch (Exception e) {
                c.reject("解压失败：" + e.getMessage());
            }
        }).start();
    }

    /* ---------- 内部实现 ---------- */

    private JSObject ok(boolean ready, boolean started) {
        JSObject r = new JSObject();
        r.put("ready", ready);
        r.put("started", started);
        r.put("port", PORT);
        return r;
    }

    private boolean health(int timeoutMs) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL("http://127.0.0.1:" + PORT + "/api/health").openConnection();
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            return c.getResponseCode() == 200;
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private void spawn(File rootfs) throws IOException {
        Context ctx = getContext();
        String libDir = ctx.getApplicationInfo().nativeLibraryDir;
        File proot = new File(libDir, "libproot.so");
        if (!proot.exists()) throw new IOException("缺少 libproot.so（APK 打包问题）");
        File tmp = new File(ctx.getFilesDir(), "proot-tmp");
        tmp.mkdirs();

        List<String> cmd = new ArrayList<>();
        cmd.add(proot.getAbsolutePath());
        cmd.add("--link2symlink");
        cmd.add("-0");                                  // 以 root 身份
        cmd.add("-r"); cmd.add(rootfs.getAbsolutePath());
        cmd.add("-b"); cmd.add("/dev");
        cmd.add("-b"); cmd.add("/proc");
        cmd.add("-b"); cmd.add("/sys");
        cmd.add("-b"); cmd.add("/dev/urandom:/dev/random");
        cmd.add("-w"); cmd.add("/root");
        cmd.add("/usr/bin/env");
        cmd.add("-i");
        cmd.add("HOME=/root");
        cmd.add("PATH=/usr/local/bin:/usr/bin:/bin");
        cmd.add("LANG=C.UTF-8");
        cmd.add("PYTHONUNBUFFERED=1");
        cmd.add("MATHAPP_QUIET=1");
        cmd.add("/usr/local/bin/python3");
        cmd.add("/opt/mathapp/server.py");
        cmd.add(String.valueOf(PORT));

        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.environment().put("PROOT_TMP_DIR", tmp.getAbsolutePath());
        pb.environment().put("PROOT_NO_SECCOMP", "1");
        pb.environment().put("LD_LIBRARY_PATH", libDir);
        File loader = new File(libDir, "libprootloader.so");
        if (loader.exists()) pb.environment().put("PROOT_LOADER", loader.getAbsolutePath());
        pb.redirectErrorStream(true);
        pb.redirectOutput(new File(ctx.getFilesDir(), "backend.log"));
        proc = pb.start();
    }

    private void extract(File tarGz) throws IOException {
        File d = dir();
        deleteRec(d);
        d.mkdirs();
        try (TarArchiveInputStream tin =
                     new TarArchiveInputStream(new GZIPInputStream(new java.io.BufferedInputStream(
                             new java.io.FileInputStream(tarGz), 1 << 20)))) {
            TarArchiveEntry e;
            byte[] buf = new byte[1 << 16];
            while ((e = tin.getNextTarEntry()) != null) {
                File out = new File(d, e.getName());
                if (!out.getCanonicalPath().startsWith(d.getCanonicalPath())) throw new IOException("非法路径");
                if (e.isDirectory()) { out.mkdirs(); continue; }
                out.getParentFile().mkdirs();
                try (FileOutputStream fos = new FileOutputStream(out)) {
                    int n;
                    while ((n = tin.read(buf)) > 0) fos.write(buf, 0, n);
                }
                if ((e.getMode() & 0111) != 0) out.setExecutable(true, false);
            }
        }
        new File(d, MARK).createNewFile();
    }

    private void deleteRec(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteRec(k);
        f.delete();
    }

    private String tail(File f, int max) {
        if (!f.exists()) return "";
        try (InputStream in = new java.io.FileInputStream(f)) {
            long len = f.length();
            long skip = Math.max(0, len - max);
            long skipped = 0;
            while (skipped < skip) {
                long s = in.skip(skip - skipped);
                if (s <= 0) break;
                skipped += s;
            }
            byte[] b = new byte[(int) Math.min(max, len)];
            int n = in.read(b);
            return n > 0 ? new String(b, 0, n, "UTF-8") : "";
        } catch (Exception e) {
            return "(读日志失败: " + e.getMessage() + ")";
        }
    }
}
