package com.azdezhishi.mathapp;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import androidx.activity.result.ActivityResult;

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
        if (d == null && hasAssetPack()) {
            final PluginCall c0 = call;
            new Thread(() -> {
                try {
                    notify("extract", 0, "首次启动：解压内置引擎包…");
                    extractStream(getContext().getAssets().open("rootfs.tar.gz"));
                } catch (Exception e) {
                    c0.reject("解压内置引擎包失败：" + e.getMessage());
                    return;
                }
                doStart(c0);
            }).start();
            return;
        }
        if (d == null) { call.reject("引擎包未安装：请点「选择引擎包安装」导入 rootfs.tar.gz"); return; }
        if (starting) { call.reject("正在启动中"); return; }
        doStart(call);
    }

    private void doStart(PluginCall c) {
        starting = true;
        try {
            spawn(rootfsReady());
        } catch (Exception e) { starting = false; c.reject("启动失败：" + e.getMessage()); return; }
        new Thread(() -> {
            boolean up = false;
            for (int i = 0; i < 80 && !up; i++) {          // 最多等 40s
                try { Thread.sleep(500); } catch (InterruptedException ignored) {}
                up = health(400);
            }
            starting = false;
            notify("done", 100, up ? "引擎已就绪" : "引擎还在启动");
            JSObject r = ok(up, true);
            if (up) c.resolve(r); else c.reject("后端启动超时，点「看日志」看原因");
        }).start();
    }

    /** 直接从 APK 内置的 assets/rootfs.tar.gz 安装（单文件 APK 用这个） */
    @PluginMethod
    public void installFromAssets(PluginCall call) {
        if (!hasAssetPack()) { call.reject("这个 APK 没有内置引擎包，请用「选择引擎包安装」手动导"); return; }
        final PluginCall c = call;
        new Thread(() -> {
            try {
                extractStream(getContext().getAssets().open("rootfs.tar.gz"));
                doStart(c);
            } catch (Exception e) {
                c.reject("安装失败：" + e.getMessage());
            }
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

    /** 打开系统文件选择器挑 rootfs.tar.gz，拷进私有目录后解压并直接启动（无需存储权限） */
    @PluginMethod
    public void pickAndInstall(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        startActivityForResult(call, i, "onPackPicked");
    }

    @ActivityCallback
    private void onPackPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null
                || result.getData().getData() == null) {
            call.reject("已取消");
            return;
        }
        Uri uri = result.getData().getData();
        final PluginCall c = call;
        new Thread(() -> {
            try {
                File tmp = new File(getContext().getFilesDir(), "pack-download.tar.gz");
                long total = copyUri(uri, tmp);
                notify("copy", 100, "已选择引擎包（" + (total / 1048576) + " MB）");
                extract(tmp);
                tmp.delete();
                boolean started = false;
                try { spawn(rootfsReady()); } catch (Exception e) { /* 启动失败也算安装成功 */ }
                for (int i = 0; i < 40; i++) {
                    try { Thread.sleep(500); } catch (InterruptedException ignored) {}
                    if (health(400)) { started = true; break; }
                }
                notify("done", 100, started ? "引擎已就绪" : "已安装，引擎还在启动");
                JSObject r = new JSObject();
                r.put("installed", rootfsReady() != null);
                r.put("ready", started);
                c.resolve(r);
            } catch (Exception e) {
                c.reject("安装失败：" + e.getMessage());
            }
        }).start();
    }

    private long copyUri(Uri uri, File dst) throws IOException {
        long total = 0, len = -1;
        try (InputStream in = getContext().getContentResolver().openInputStream(uri);
             FileOutputStream out = new FileOutputStream(dst)) {
            if (in == null) throw new IOException("无法读取所选文件");
            byte[] buf = new byte[1 << 16];
            int n; long lastPct = -1;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n); total += n;
                long pct = total / (20L * 1048576L);   // 每 20MB 报一次
                if (pct != lastPct) { lastPct = pct; notify("copy", (int) Math.min(99, pct * 5), "拷贝中 " + (total / 1048576) + " MB"); }
            }
        }
        return total;
    }

    private void notify(String phase, int pct, String msg) {
        JSObject o = new JSObject();
        o.put("phase", phase);
        o.put("pct", pct);
        o.put("msg", msg);
        notifyListeners("installProgress", o);
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
        try (InputStream raw = new java.io.BufferedInputStream(new java.io.FileInputStream(tarGz), 1 << 20)) {
            extractStream(raw);
        }
    }

    /** 内置引擎包是否随 APK 打包（assets/rootfs.tar.gz） */
    private boolean hasAssetPack() {
        try {
            String[] list = getContext().getAssets().list("");
            if (list == null) return false;
            for (String n : list) if ("rootfs.tar.gz".equals(n)) return true;
        } catch (IOException ignored) {}
        return false;
    }

    private void extractStream(InputStream rawIn) throws IOException {
        File d = dir();
        deleteRec(d);
        d.mkdirs();
        notify("extract", 0, "开始解压…");
        try (TarArchiveInputStream tin =
                     new TarArchiveInputStream(new GZIPInputStream(new java.io.BufferedInputStream(rawIn, 1 << 20)))) {
            TarArchiveEntry e;
            byte[] buf = new byte[1 << 16];
            int seen = 0;
            while ((e = tin.getNextTarEntry()) != null) {
                if (++seen % 4000 == 0) notify("extract", 100, "解压中（" + seen + " 项）");
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
        notify("extract", 100, "解压完成");
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
