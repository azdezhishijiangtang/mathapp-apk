package com.azdezhishi.mathapp;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/** 应用内更新：下载新 APK（带 sha256 校验）→ 拉起系统安装器。安装确认必须用户自己点，无法静默。 */
@CapacitorPlugin(name = "Updater")
public class UpdaterPlugin extends Plugin {

    private volatile boolean cancelled = false;

    private static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    @PluginMethod
    public void current(PluginCall call) {
        try {
            JSObject r = new JSObject();
            r.put("versionCode", getContext().getPackageManager()
                    .getPackageInfo(getContext().getPackageName(), 0).versionCode);
            r.put("versionName", getContext().getPackageManager()
                    .getPackageInfo(getContext().getPackageName(), 0).versionName);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("读取版本失败: " + e.getMessage());
        }
    }

    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject r = new JSObject();
        boolean ok = true;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ok = getContext().getPackageManager().canRequestPackageInstalls();
            }
        } catch (Exception ignored) { }
        r.put("ok", ok);
        call.resolve(r);
    }

    @PluginMethod
    public void openUnknownSources(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
                i.setData(Uri.parse("package:" + getContext().getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("打不开系统设置: " + e.getMessage());
        }
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        cancelled = true;
        call.resolve();
    }

    @PluginMethod
    public void download(final PluginCall call) {
        final String url = call.getString("url");
        final String sha = call.getString("sha256", "");
        String name = call.getString("name", "mathapp-update.apk");
        if (url == null || url.isEmpty()) { call.reject("没有下载地址"); return; }
        final File dir = new File(getContext().getCacheDir(), "upd");
        if (!dir.exists() && !dir.mkdirs()) { call.reject("建不了缓存目录"); return; }
        final File out = new File(dir, name);
        cancelled = false;
        new Thread(new Runnable() {
            public void run() {
                HttpURLConnection conn = null;
                FileOutputStream fos = null;
                try {
                    conn = (HttpURLConnection) new URL(url).openConnection();
                    conn.setConnectTimeout(20000);
                    conn.setReadTimeout(30000);
                    conn.setInstanceFollowRedirects(true);
                    conn.connect();
                    int code = conn.getResponseCode();
                    if (code != 200) { call.reject("下载失败：HTTP " + code); return; }
                    long total = conn.getContentLength();
                    InputStream in = conn.getInputStream();
                    fos = new FileOutputStream(out);
                    MessageDigest md = MessageDigest.getInstance("SHA-256");
                    byte[] buf = new byte[65536];
                    long got = 0, lastTick = 0;
                    while (true) {
                        int n = in.read(buf);
                        if (n < 0) break;
                        fos.write(buf, 0, n);
                        md.update(buf, 0, n);
                        got += n;
                        if (cancelled) break;
                        if (got - lastTick >= 1048576L) {
                            lastTick = got;
                            JSObject p = new JSObject();
                            p.put("got", got);
                            p.put("total", total);
                            notifyListeners("progress", p);
                        }
                    }
                    fos.flush();
                    fos.close();
                    fos = null;
                    if (cancelled) { out.delete(); call.reject("已取消"); return; }
                    if (sha != null && sha.length() > 0) {
                        String h = hex(md.digest());
                        if (!h.equalsIgnoreCase(sha)) {
                            out.delete();
                            call.reject("校验失败：文件不完整（" + got + " 字节），请重试");
                            return;
                        }
                    }
                    JSObject r = new JSObject();
                    r.put("path", out.getAbsolutePath());
                    r.put("size", out.length());
                    call.resolve(r);
                } catch (Exception e) {
                    call.reject("下载失败：" + e.getMessage());
                } finally {
                    try { if (fos != null) fos.close(); } catch (Exception ignored) { }
                    try { if (conn != null) conn.disconnect(); } catch (Exception ignored) { }
                }
            }
        }).start();
    }

    @PluginMethod
    public void install(PluginCall call) {
        String path = call.getString("path");
        try {
            File f = new File(path == null ? "" : path);
            if (!f.exists()) { call.reject("安装包不在缓存里，请重新下载"); return; }
            Uri uri = FileProvider.getUriForFile(getContext(),
                    getContext().getPackageName() + ".fileprovider", f);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            JSObject r = new JSObject();
            r.put("ok", true);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("拉起安装失败：" + e.getMessage());
        }
    }
}
