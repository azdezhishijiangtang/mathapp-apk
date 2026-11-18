#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""数学答疑应用 · 本地服务
- 静态页面（web/）
- /api/llm     模型调用转发（浏览器直连会被 CORS 拦，这里代转，支持流式）
- /api/verify  本地验证引擎（SymPy / z3 / Arb / PARI）
- /api/health  引擎状态
启动：python3 server.py [端口，默认 8080]
"""
import json, os, sys, threading, time, urllib.request, urllib.error
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import engine  # noqa

WEB = os.path.join(HERE, "web")
MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
        ".webmanifest": "application/manifest+json; charset=utf-8",
        ".wasm": "application/wasm", ".gz": "application/gzip",
        ".traineddata": "application/octet-stream",
        ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon"}

STATE = {"cache": {}, "lock": threading.Lock()}
CACHE_MAX = 200


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "mathapp/1.0"

    def log_message(self, fmt, *a):
        if os.environ.get("MATHAPP_QUIET"):
            return
        sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % a))

    # ---------------- 基础 ----------------
    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            return json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            return {}

    # ---------------- 路由 ----------------
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        p = self.path.split("?")[0]
        if p in ("/", "/index.html"):
            return self._file(os.path.join(WEB, "index.html"))
        if p == "/api/health":
            return self._send(200, self._health())
        if p.startswith("/static/"):
            return self._file(os.path.join(WEB, p[len("/static/"):]))
        if p == "/favicon.ico":
            return self._send(204, b"")
        return self._file(os.path.join(WEB, p.lstrip("/")))

    def do_POST(self):
        p = self.path.split("?")[0]
        if p == "/api/verify":
            data = self._json_body()
            return self._verify(data)
        if p == "/api/llm":
            return self._llm(self._json_body())
        if p == "/api/calc":
            data = self._json_body()
            try:
                v = engine.to_sym(data.get("expr", ""))
                return self._send(200, {"ok": True, "sympy": str(v),
                                        "numeric": str(v.evalf(30)) if v.free_symbols == set() else None})
            except Exception as e:
                return self._send(200, {"ok": False, "error": str(e)[:200]})
        return self._send(404, {"error": "not found"})

    # ---------------- 具体处理 ----------------
    def _file(self, path):
        path = os.path.normpath(path)
        if not path.startswith(WEB) or not os.path.isfile(path):
            return self._send(404, {"error": "not found"})
        ext = os.path.splitext(path)[1]
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def _health(self):
        info = {"ok": True, "engines": []}
        try:
            import sympy
            info["engines"].append("sympy %s" % sympy.__version__)
        except Exception:
            pass
        try:
            import z3
            info["engines"].append("z3 %s" % z3.get_version_string())
        except Exception:
            pass
        try:
            import flint
            info["engines"].append("flint/arb %s" % flint.__version__)
        except Exception:
            pass
        try:
            import subprocess
            r = subprocess.run(["gp", "--version"], capture_output=True, text=True, timeout=8)
            for line in ((r.stdout or "") + (r.stderr or "")).splitlines():
                if "GP/PARI" in line:
                    info["engines"].append(line.strip())
                    break
        except Exception:
            pass
        for mod, label in (("numpy", "numpy"), ("ortools", "CP-SAT"), ("cvc5", "cvc5")):
            try:
                m = __import__(mod)
                info["engines"].append("%s %s" % (label, getattr(m, "__version__", "?")))
            except Exception:
                pass
        info["version"] = "3.1"
        info["backends"] = ["sympy", "z3", "arb", "pari", "numpy", "cpsat", "cvc5", "groebner"]
        info["cache_entries"] = len(STATE["cache"])
        return info

    def _verify(self, data):
        claims = data.get("claims") or []
        if not isinstance(claims, list) or not claims:
            return self._send(200, {"results": [], "summary": {"total": 0}, "coverage": 0})
        try:
            out = engine.verify_claims(claims)
        except Exception as e:
            return self._send(200, {"results": [], "error": "%s: %s" % (type(e).__name__, str(e)[:200])})
        return self._send(200, out)

    def _llm(self, data):
        base = (data.get("baseUrl") or "").rstrip("/")
        key = data.get("apiKey") or ""
        if not base:
            return self._send(400, {"error": "未配置 baseUrl（设置里填 OpenAI 兼容地址，如 http://127.0.0.1:7863/v1）"})
        url = base + ("/chat/completions" if base.endswith("/v1") else "/v1/chat/completions")
        payload = {
            "model": data.get("model") or "cn:auto",
            "messages": data.get("messages") or [],
            "temperature": data.get("temperature", 0.6),
            "max_tokens": int(data.get("maxTokens") or 24000),
            "stream": bool(data.get("stream", True)),
        }
        if data.get("thinking") is False:
            payload["thinking"] = {"type": "disabled"}
        hdr = {"Content-Type": "application/json"}
        if key:
            hdr["Authorization"] = "Bearer " + key
        req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=hdr, method="POST")
        timeout = int(data.get("timeout") or 300)
        try:
            resp = urllib.request.urlopen(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode("utf-8", "ignore")[:500]
            except Exception:
                pass
            return self._send(502, {"error": "上游 %s：%s" % (e.code, body)})
        except Exception as e:
            return self._send(502, {"error": "上游连接失败：%s: %s" % (type(e).__name__, str(e)[:200])})

        if not payload["stream"]:
            try:
                body = resp.read()
            except Exception as e:
                return self._send(502, {"error": "读取失败 %s" % e})
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
            return

        # 流式转发（原样透传 SSE，浏览器侧解析）
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.close_connection = True
        try:
            while True:
                line = resp.readline()
                if not line:
                    break
                self.wfile.write(line)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            try:
                self.wfile.write(("data: " + json.dumps({"error": str(e)[:200]}) + "\n\n").encode())
                self.wfile.flush()
            except Exception:
                pass
        finally:
            try:
                resp.close()
            except Exception:
                pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    srv.daemon_threads = True
    print("mathapp on http://127.0.0.1:%d  (web=%s)" % (port, WEB), flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
